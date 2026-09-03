import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, voids, shifts } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  menuItemId: string;
  managerEmployeeId: string;
}

function context(fixture: Fixture, role: string, employeeId: string, permissions = ["shifts.manage"]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(permissions),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Shift report tenant", slug: `shift-report-${randomUUID()}` } });
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

  const role = await prisma.role.create({ data: { restaurantId: restaurant.id, name: "MANAGER", isSystem: true } });
  const manager = await prisma.employee.create({
    data: { restaurantId: restaurant.id, firstName: "Ana", lastName: "Menadžer" },
  });
  await prisma.employeeRole.create({ data: { employeeId: manager.id, roleId: role.id } });

  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, menuItemId: menuItem.id, managerEmployeeId: manager.id };
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

describe("shift closing report content: printable end-of-shift summary", () => {
  it("refuses to build a report for a shift that is still OPEN", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", fixture.managerEmployeeId);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 1000 });

    await expect(shifts.getShiftReportContent(manager, shift.id)).rejects.toThrow("nije zatvorena");
  });

  it("matches the exact frozen totals recorded by closeShift — never recomputes cash/card/counted/difference", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", fixture.managerEmployeeId);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 1000 });
    const waiter = context(fixture, "WAITER", "waiter-1", ["menu.view", "orders.create", "orders.submit"]);
    await payOrder(fixture, waiter, "CASH"); // 120.00
    await payOrder(fixture, waiter, "CARD"); // 120.00

    const closed = await shifts.closeShift(manager, shift.id, { countedCash: 1115 });
    const report = await shifts.getShiftReportContent(manager, shift.id);

    expect(report.kind).toBe("SHIFT_REPORT");
    expect(report.restaurantName).toBe("Restaurant A");
    expect(report.employeeName).toBe("Ana Menadžer");
    expect(report.employeeRole).toBe("MANAGER");
    expect(report.currency).toBe("RSD");
    expect(report.orderCount).toBe(closed.orderCount);
    expect(report.totalRevenue).toBe(closed.totalRevenue?.toString());
    expect(report.cardTotal).toBe(closed.cardTotal?.toString());
    expect(report.cashTotal).toBe("120");
    expect(report.expectedCash).toBe(closed.expectedCash?.toString());
    expect(report.countedCash).toBe(closed.countedCash?.toString());
    expect(report.cashDifference).toBe(closed.cashDifference?.toString());
    expect(report.cashDifference).toBe("-5");
  });

  it("includes discount and void aggregates for the shift, zero when none occurred", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", fixture.managerEmployeeId);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    const waiter = context(fixture, "WAITER", "waiter-1", ["menu.view", "orders.create", "orders.submit"]);
    await payOrder(fixture, waiter, "CASH");

    const closed = await shifts.closeShift(manager, shift.id, { countedCash: 120 });
    const report = await shifts.getShiftReportContent(manager, shift.id);
    expect(report.discountTotal).toBe("0");
    expect(report.voidCount).toBe(0);
    expect(report.voidValue).toBe("0");
    expect(closed.status).toBe("CLOSED");
  });

  it("sums discounts applied to paid orders and void value recorded during the shift", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", fixture.managerEmployeeId);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    const waiter = context(fixture, "WAITER", "waiter-1", ["menu.view", "orders.create", "orders.submit"]);

    // Discounted order (100 -> discount 20 -> tax on 80 = 16 -> total 96)
    const discountedOrder = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, discountedOrder.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submittedDiscounted = await orders.submitOrder(waiter, discountedOrder.id, { idempotencyKey: randomUUID() });
    await billing.applyOrderDiscount(manager, submittedDiscounted.id, { amount: 20, reason: "Reklamacija hrane" });
    await billing.completePayment(waiter, submittedDiscounted.id, { method: "CASH" });

    // Voided item on a separate order
    const voidedOrder = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const voidedItem = await orders.addItem(waiter, voidedOrder.id, { menuItemId: fixture.menuItemId, quantity: 2 });
    await orders.submitOrder(waiter, voidedOrder.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(manager, voidedOrder.id, voidedItem.id, {
      quantity: 1,
      reasonCode: "OTHER",
      explanation: "Gost je promenio mišljenje pre pripreme",
    });
    await billing.completePayment(waiter, voidedOrder.id, { method: "CASH" });

    await shifts.closeShift(manager, shift.id, { countedCash: 0 });
    const report = await shifts.getShiftReportContent(manager, shift.id);

    expect(Number(report.discountTotal)).toBeCloseTo(20, 5);
    expect(report.voidCount).toBe(1);
    expect(Number(report.voidValue)).toBeGreaterThan(0);
  });

  it("is idempotent and side-effect free — calling it repeatedly returns identical content for a closed shift", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", fixture.managerEmployeeId);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 500 });
    const waiter = context(fixture, "WAITER", "waiter-1", ["menu.view", "orders.create", "orders.submit"]);
    await payOrder(fixture, waiter, "CASH");
    await shifts.closeShift(manager, shift.id, { countedCash: 620 });

    const first = await shifts.getShiftReportContent(manager, shift.id);
    const second = await shifts.getShiftReportContent(manager, shift.id);
    const third = await shifts.getShiftReportContent(manager, shift.id);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("falls back to a safe placeholder rather than throwing when the closing employee cannot be resolved", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", fixture.managerEmployeeId);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    await shifts.closeShift(manager, shift.id, { countedCash: 0 });

    // Simulate a shift closed by an id with no matching Employee row.
    await prisma.shift.update({ where: { id: shift.id }, data: { closedBy: "ghost-employee" } });

    const report = await shifts.getShiftReportContent(manager, shift.id);
    expect(report.employeeName).toBe("?");
    expect(report.employeeRole).toBe("?");
  });

  it("rejects a manager without location access to the shift", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", fixture.managerEmployeeId);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    await shifts.closeShift(manager, shift.id, { countedCash: 0 });

    const outsider: AuthContext = { ...manager, employeeId: "mgr-2", userId: "mgr-2", locationIds: [] };
    await expect(shifts.getShiftReportContent(outsider, shift.id)).rejects.toThrow();
  });
});
