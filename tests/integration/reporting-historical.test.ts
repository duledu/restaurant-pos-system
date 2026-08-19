import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, voids, reporting } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  menuItemId: string;
}

function context(fixture: Fixture, role: string, employeeId: string, permissions: string[] = ["audit.view"]): AuthContext {
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
  const tenant = await prisma.tenant.create({ data: { name: "History tenant", slug: `history-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const menuItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Original Name",
      slug: `item-${randomUUID()}`,
      price: "1000.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });
  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, menuItemId: menuItem.id };
}

async function payOrder(fixture: Fixture, waiter: AuthContext, quantity = 1) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity });
  const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
  return billing.completePayment(waiter, submitted.id, { method: "CASH", tenderedAmount: 100000 });
}

const VALID_EXPLANATION = "Gost je promenio narudžbinu pre nego što je hrana stigla do stola.";

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("reporting: historical accuracy survives later menu/employee changes", () => {
  it("keeps the item's historical name and price in item-sales after the menu item is renamed and repriced", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1", ["audit.view"]);
    await payOrder(fixture, waiter, 2);

    await prisma.menuItem.update({
      where: { id: fixture.menuItemId },
      data: { name: "Renamed Item", price: "9999.00" },
    });

    const manager = context(fixture, "MANAGER", "mgr-1");
    const report = await reporting.getSoldItems(manager, { locationId: "ALL", preset: "today" });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].name).toBe("Original Name");
    expect(report.rows[0].totalRevenue).toBe("2000");
  });

  it("keeps a deactivated employee's name/role resolvable in the historical employee report", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1", ["audit.view"]);

    // Zaposleni mora postojati u bazi (resolveEmployeeDisplayNames traži
    // Employee.id) da bi test proverio da DEAKTIVACIJA (ne brisanje) ne
    // ruši istorijski izveštaj — vidi Employee.status u schema.prisma.
    const user = await prisma.user.create({ data: { username: `waiter-${randomUUID()}@test.local`, passwordHash: "x" } });
    const employee = await prisma.employee.create({
      data: { id: "waiter-1", restaurantId: fixture.restaurantId, userId: user.id, firstName: "Marko", lastName: "Konobar" },
    });

    await payOrder(fixture, waiter, 1);

    await prisma.employee.update({ where: { id: employee.id }, data: { status: "TERMINATED" } });

    const manager = context(fixture, "MANAGER", "mgr-1");
    const activity = await reporting.getEmployeeActivity(manager, { locationId: "ALL", preset: "today" });
    const row = activity.find((r) => r.employeeId === "waiter-1");
    expect(row).toBeTruthy();
    expect(row?.employeeName).toBe("Marko Konobar");
  });

  it("reports correct cash/card totals and reconciles exactly against underlying Payment rows", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1", ["audit.view"]);
    await payOrder(fixture, waiter, 1); // CASH, 1200 (with tax)

    const manager = context(fixture, "MANAGER", "mgr-1");
    const summary = await reporting.getSalesSummary(manager, { locationId: "ALL", preset: "today" });

    const payments = await prisma.payment.findMany({ where: { restaurantId: fixture.restaurantId } });
    const expectedTotal = payments.reduce((s, p) => s + Number(p.amount), 0);
    expect(Number(summary.totalSales)).toBeCloseTo(expectedTotal, 2);
    expect(Number(summary.cashSales)).toBeCloseTo(expectedTotal, 2);
    expect(summary.cardSales).toBe("0");
    expect(summary.completedOrders).toBe(1);
  });

  it("reports the applied order discount correctly in netSales/grossSales/discountTotal", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1", ["audit.view"]);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const manager = context(fixture, "MANAGER", "mgr-1", ["audit.view"]);
    await billing.applyOrderDiscount(manager, submitted.id, { amount: 100, reason: "Stalni gost" });
    await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    const summary = await reporting.getSalesSummary(manager, { locationId: "ALL", preset: "today" });
    expect(summary.discountTotal).toBe("100");
    expect(summary.netSales).toBe("1100"); // 1000 + 20% PDV - 100 popust = 1100
    expect(summary.grossSales).toBe("1200");
  });

  it("correctly represents voided items in the void report and excludes them from sold-items revenue", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1", ["audit.view"]);
    const manager = context(fixture, "MANAGER", "mgr-1", ["audit.view"]);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 3 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 1,
      reasonCode: "WRONG_QUANTITY",
      explanation: VALID_EXPLANATION,
    });
    await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    const voidReport = await reporting.getVoidReport(manager, { locationId: "ALL", preset: "today" });
    expect(voidReport).toHaveLength(1);
    expect(voidReport[0].voidedQuantity).toBe(1);

    const soldItems = await reporting.getSoldItems(manager, { locationId: "ALL", preset: "today" });
    // 2 preostale (nevoidovane) jedinice po 1000 = 2000
    expect(soldItems.rows[0].totalRevenue).toBe("2000");
    expect(soldItems.rows[0].voidedQuantity).toBe(1);
  });

  it("shift reconciliation totals in the shift report match the frozen Shift fields from closeShift", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1", ["audit.view", "shifts.manage"]);
    const manager = context(fixture, "MANAGER", "mgr-1", ["audit.view", "shifts.manage"]);
    await payOrder(fixture, waiter, 1);

    const shift = await prisma.shift.findFirstOrThrow({ where: { restaurantId: fixture.restaurantId, status: "OPEN" } });
    const { shifts } = await import("@rcs/domain");
    const closed = await shifts.closeShift(manager, shift.id, { countedCash: Number(shift.openingCash) + 1200 });

    const report = await reporting.getShiftReport(manager, { locationId: "ALL", preset: "today" });
    const row = report.find((r) => r.id === shift.id)!;
    expect(row.cashDifference).toBe(closed.cashDifference?.toString());
    expect(row.totalSales).toBe(closed.totalRevenue?.toString());
  });

  it("a custom date range 5 years in the past can still query correctly (no artificial history cap)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1", ["audit.view"]);
    const { payment } = await payOrder(fixture, waiter, 1);

    const fiveYearsAgo = new Date();
    fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    await prisma.payment.update({ where: { id: payment.id }, data: { completedAt: fiveYearsAgo } });

    const manager = context(fixture, "MANAGER", "mgr-1");
    const from = new Date(fiveYearsAgo);
    from.setDate(from.getDate() - 1);
    const to = new Date(fiveYearsAgo);
    to.setDate(to.getDate() + 1);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const summary = await reporting.getSalesSummary(manager, { locationId: "ALL", preset: "custom", from: iso(from), to: iso(to) });
    expect(summary.completedOrders).toBe(1);

    // Isti period "danas" (default preset) NE sme videti tu (petogodišnju) prodaju.
    const todaySummary = await reporting.getSalesSummary(manager, { locationId: "ALL", preset: "today" });
    expect(todaySummary.completedOrders).toBe(0);
  });
});
