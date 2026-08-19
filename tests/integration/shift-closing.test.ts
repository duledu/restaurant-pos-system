import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, shifts } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  menuItemId: string;
}

function context(fixture: Fixture, role: string, employeeId: string, locationIds = [fixture.locationId]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds,
    roles: [role],
    permissions: new Set(["shifts.manage"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Shift tenant", slug: `shift-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const menuItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Burger",
      slug: `burger-${randomUUID()}`,
      price: "100.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });

  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, menuItemId: menuItem.id };
}

async function payOrder(fixture: Fixture, waiter: AuthContext, method: "CASH" | "CARD", quantity = 1) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity });
  const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
  return billing.completePayment(waiter, submitted.id, { method });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("shift closing and cash reconciliation", () => {
  it("computes expected cash from opening float + cash payments, ignoring card sales", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 5000 });
    const waiter = context(fixture, "WAITER", "waiter-1");

    await payOrder(fixture, waiter, "CASH"); // 120.00
    await payOrder(fixture, waiter, "CARD"); // 120.00

    const summary = await shifts.getShiftSummary(manager, shift.id);
    expect(summary.cashTotal).toBe("120");
    expect(summary.cardTotal).toBe("120");
    expect(summary.expectedCash).toBe("5120"); // 5000 + 120 cash, card excluded
    expect(summary.totalRevenue).toBe("240");
    expect(summary.orderCount).toBe(2);
    expect(summary.canClose).toBe(true);
  });

  it("records a visible, unaltered cash difference — never silently corrected", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 1000 });
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrder(fixture, waiter, "CASH"); // expected = 1000 + 120 = 1120

    const closed = await shifts.closeShift(manager, shift.id, { countedCash: 1100 });
    expect(closed.expectedCash?.toString()).toBe("1120");
    expect(closed.countedCash?.toString()).toBe("1100");
    expect(closed.cashDifference?.toString()).toBe("-20");
    expect(closed.status).toBe("CLOSED");
  });

  it("refuses to close a shift with open (unpaid) orders", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await expect(shifts.closeShift(manager, shift.id, { countedCash: 0 })).rejects.toThrow("otvoreni računi");
    const summary = await shifts.getShiftSummary(manager, shift.id);
    expect(summary.canClose).toBe(false);
    expect(summary.openOrders).toHaveLength(1);
  });

  it("prevents closing the same shift twice", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });

    await shifts.closeShift(manager, shift.id, { countedCash: 0 });
    await expect(shifts.closeShift(manager, shift.id, { countedCash: 0 })).rejects.toThrow("već zatvorena");
  });

  it("allows only one of two concurrent close attempts on the same shift to commit", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });

    const results = await Promise.allSettled([
      shifts.closeShift(manager, shift.id, { countedCash: 0 }),
      shifts.closeShift(manager, shift.id, { countedCash: 999 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("rejects closing from an employee without location access", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });

    const outsider = context(fixture, "MANAGER", "mgr-2", []);
    await expect(shifts.closeShift(outsider, shift.id, { countedCash: 0 })).rejects.toThrow();
  });

  it("allows opening a fresh shift on the location again after the previous one closes", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    await shifts.closeShift(manager, shift.id, { countedCash: 0 });

    const next = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 200 });
    expect(next.id).not.toBe(shift.id);
    expect(next.status).toBe("OPEN");
  });
});
