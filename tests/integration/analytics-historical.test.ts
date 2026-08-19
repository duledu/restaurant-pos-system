import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, analytics } from "@rcs/domain";
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
  const tenant = await prisma.tenant.create({ data: { name: "Analytics history tenant", slug: `analytics-hist-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Original Category", slug: `cat-${randomUUID()}`, type: "FOOD" } });
  const menuItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Original Name", slug: `item-${randomUUID()}`, price: "1000.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, menuItemId: menuItem.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("analytics: historical snapshot correctness survives later menu/employee changes", () => {
  it("top-selling items keep the historical name/price after the menu item is renamed and repriced", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 2 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    await prisma.menuItem.update({ where: { id: fixture.menuItemId }, data: { name: "Renamed Item", price: "9999.00" } });

    const manager = context(fixture, "MANAGER", "mgr-1");
    const result = await analytics.getTopAndLowItems(manager, { locationId: "ALL", preset: "today" });
    expect(result.topItems).toHaveLength(1);
    expect(result.topItems[0].name).toBe("Original Name");
    expect(result.topItems[0].totalRevenue).toBe("2000");
  });

  it("category performance labels itself isLiveCategoryName — renaming the category changes the historical display", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    await prisma.menuCategory.updateMany({ where: { restaurantId: fixture.restaurantId }, data: { name: "Renamed Category" } });

    const manager = context(fixture, "MANAGER", "mgr-1");
    const result = await analytics.getCategoryPerformance(manager, { locationId: "ALL", preset: "today" });
    expect(result.isLiveCategoryName).toBe(true);
    expect(result.categories[0].categoryName).toBe("Renamed Category"); // dokumentovano ograničenje, ne greška
  });

  it("a deactivated (TERMINATED) employee still resolves correctly in employee performance and normalized metrics", async () => {
    const fixture = await createFixture();
    const user = await prisma.user.create({ data: { username: `waiter-${randomUUID()}@test.local`, passwordHash: "x" } });
    const employee = await prisma.employee.create({
      data: { id: "waiter-1", restaurantId: fixture.restaurantId, userId: user.id, firstName: "Marko", lastName: "Konobar" },
    });
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    await prisma.employee.update({ where: { id: employee.id }, data: { status: "TERMINATED" } });

    const manager = context(fixture, "MANAGER", "mgr-1");
    const [perf, normalized] = await Promise.all([
      analytics.getEmployeePerformance(manager, { locationId: "ALL", preset: "today" }),
      analytics.getEmployeeNormalizedMetrics(manager, { locationId: "ALL", preset: "today" }),
    ]);
    expect(perf.find((r) => r.employeeId === "waiter-1")?.employeeName).toBe("Marko Konobar");
    expect(normalized.rows.find((r) => r.employeeId === "waiter-1")?.employeeName).toBe("Marko Konobar");
  });

  it("insights and KPI comparison still work correctly for a custom range covering 5+ years of history", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    const { payment } = await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    const sixYearsAgo = new Date();
    sixYearsAgo.setFullYear(sixYearsAgo.getFullYear() - 6);
    await prisma.payment.update({ where: { id: payment.id }, data: { completedAt: sixYearsAgo } });
    // Restoran mora "postojati" pre te transakcije da poređenje ne bi bilo
    // automatski odbačeno kao "pre osnivanja restorana".
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { createdAt: new Date(sixYearsAgo.getTime() - 86_400_000) } });

    const from = new Date(sixYearsAgo.getFullYear(), 0, 1).toISOString().slice(0, 10);
    const to = new Date(sixYearsAgo.getFullYear(), 11, 31).toISOString().slice(0, 10);

    const manager = context(fixture, "MANAGER", "mgr-1");
    const kpi = await analytics.getKpiComparison(manager, { locationId: "ALL", preset: "custom", from, to });
    expect(kpi.current.completedOrders).toBe(1);
    expect(kpi.current.totalSales).toBe("1200");
  });
});
