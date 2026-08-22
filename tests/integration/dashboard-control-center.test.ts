/**
 * P2.3 — Owner Control Center integration tests.
 *
 * Covers only the NEW composition surface added for the Control Center:
 * getCurrentStatus's kitchen/bar pending-item counts + per-shift opening
 * cash, and inventory.getStockAttention's OUT/LOW aggregation (P1.1
 * semantics reused, not reinvented). KPI/void/cash-discrepancy reconciliation
 * itself is already covered by P2.1's analytics-reconciliation.test.ts and
 * P2.2's antifraud.test.ts — not duplicated here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { ForbiddenError } from "@rcs/auth";
import { orders, reporting, inventory } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  otherLocationId: string;
  tableId: string;
  kitchenItemId: string;
  barItemId: string;
}

function ctx(fixture: Fixture, role: string, employeeId: string, permissions: string[], locationIds = [fixture.locationId]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds,
    roles: [role],
    permissions: new Set(permissions),
  };
}

function managerCtx(fixture: Fixture, employeeId = "mgr-1", locationIds = [fixture.locationId]): AuthContext {
  return ctx(fixture, "MANAGER", employeeId, ["audit.view", "inventory.view", "inventory.manage", "shifts.manage", "orders.print"], locationIds);
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Control center tenant", slug: `cc-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD", timezone: "Europe/Belgrade" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Other" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "mgr-1", openingCash: 4000 } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" } });
  const kitchenItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, price: "800.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const barItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Coca-Cola", slug: `cola-${randomUUID()}`, price: "250.00", taxRate: "20", preparationStation: "BAR" },
  });
  return { restaurantId: restaurant.id, locationId: location.id, otherLocationId: otherLocation.id, tableId: table.id, kitchenItemId: kitchenItem.id, barItemId: barItem.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("operational state: kitchen/bar pending items and shift opening cash", () => {
  it("counts items still awaiting KITCHEN/BAR completion, excluding SERVED and CANCELLED", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(manager, { tableId: fixture.tableId });
    const kitchenItemRow = await orders.addItem(manager, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
    await orders.addItem(manager, order.id, { menuItemId: fixture.barItemId, quantity: 2 });
    await orders.submitOrder(manager, order.id, { idempotencyKey: randomUUID() });

    // Kuhinjska stavka je servirana -> ne treba da se broji kao "čeka".
    await prisma.orderItemStation.update({
      where: { orderItemId_station: { orderItemId: kitchenItemRow.id, station: "KITCHEN" } },
      data: { status: "SERVED" },
    });

    const status = await reporting.getCurrentStatus(manager, { locationId: "ALL" });
    expect(status.kitchenPendingItems).toBe(0);
    expect(status.barPendingItems).toBe(1); // jedan OrderItemStation red za bar stavku (kolicina se ne racuna po komadu ovde)
  });

  it("exposes opening cash for each shift on duty, and reports 'no active shift' shape when none is open", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const status = await reporting.getCurrentStatus(manager, { locationId: "ALL" });
    expect(status.openShiftsCount).toBe(1);
    expect(status.shiftsOnDuty[0].openingCash).toBe("4000");

    await prisma.shift.updateMany({ where: { restaurantId: fixture.restaurantId }, data: { status: "CLOSED", closedAt: new Date(), closedBy: "mgr-1", countedCash: 4000, expectedCash: 4000, cashDifference: 0 } });
    const closedStatus = await reporting.getCurrentStatus(manager, { locationId: "ALL" });
    expect(closedStatus.openShiftsCount).toBe(0);
    expect(closedStatus.shiftsOnDuty).toEqual([]);
  });
});

describe("inventory attention: OUT/LOW semantics match P1.1 (reused, not reinvented)", () => {
  it("classifies an item at zero stock as OUT, and a non-zero item at or below its minimum as LOW", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const outItem = await inventory.initializeTracking(manager, { menuItemId: fixture.kitchenItemId, locationId: fixture.locationId, initialStock: 5 });
    await inventory.setMinimumStock(manager, fixture.kitchenItemId, 10);
    await inventory.adjustStock(manager, outItem.id, { delta: -5, reason: "Prodato/potrošeno u testu" }); // 5 -> 0 => OUT

    const lowItem = await inventory.initializeTracking(manager, { menuItemId: fixture.barItemId, locationId: fixture.locationId, initialStock: 8 });
    await inventory.setMinimumStock(manager, fixture.barItemId, 10); // 8 <= 10 => LOW

    const summary = await inventory.getStockAttention(manager, "ALL");
    expect(summary.outOfStockCount).toBe(1);
    expect(summary.lowStockCount).toBe(1);
    expect(summary.worstItems[0].status).toBe("out"); // OUT se prikazuje pre LOW
    expect(summary.worstItems.map((i) => i.name)).toContain("Pljeskavica");
    expect(summary.worstItems.map((i) => i.name)).toContain("Coca-Cola");
    void lowItem;
  });

  it("does not flag an item with healthy stock, and excludes items with tracking disabled", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const item = await inventory.initializeTracking(manager, { menuItemId: fixture.kitchenItemId, locationId: fixture.locationId, initialStock: 50 });
    await inventory.setMinimumStock(manager, fixture.kitchenItemId, 5); // 50 > 5 => OK, ne LOW

    const summary = await inventory.getStockAttention(manager, "ALL");
    expect(summary.outOfStockCount).toBe(0);
    expect(summary.lowStockCount).toBe(0);
    expect(summary.worstItems).toEqual([]);

    // Praćenje isključeno -> stavka se ne prijavljuje čak ni kad bi bila OUT.
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { currentStock: 0 } });
    await inventory.setTrackingEnabled(manager, fixture.kitchenItemId, false);
    const summaryAfterDisable = await inventory.getStockAttention(manager, "ALL");
    expect(summaryAfterDisable.outOfStockCount).toBe(0);
  });

  it("a manager scoped to Location A cannot see Location B's stock attention", async () => {
    const fixture = await createFixture();
    const managerA = managerCtx(fixture, "mgr-a", [fixture.locationId]);
    await inventory.initializeTracking(managerA, { menuItemId: fixture.kitchenItemId, locationId: fixture.locationId, initialStock: 0 });

    const managerB = managerCtx(fixture, "mgr-b", [fixture.otherLocationId]);
    const summaryB = await inventory.getStockAttention(managerB, "ALL");
    expect(summaryB.outOfStockCount).toBe(0);
    expect(summaryB.worstItems).toEqual([]);

    await expect(inventory.getStockAttention(managerB, fixture.locationId)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("RBAC: WAITER/KITCHEN/BAR cannot reach owner-level Control Center data", () => {
  it("rejects getStockAttention and getCurrentStatus for non-management roles", async () => {
    const fixture = await createFixture();
    const waiter = ctx(fixture, "WAITER", "waiter-1", ["menu.view", "shifts.manage", "orders.print"]);
    const kitchen = ctx(fixture, "KITCHEN", "kds-1", ["menu.view", "production.view", "production.manage"]);
    const bar = ctx(fixture, "BAR", "bar-1", ["menu.view", "production.view", "production.manage"]);

    for (const staff of [waiter, kitchen, bar]) {
      await expect(inventory.getStockAttention(staff, "ALL")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(reporting.getCurrentStatus(staff, { locationId: "ALL" })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
