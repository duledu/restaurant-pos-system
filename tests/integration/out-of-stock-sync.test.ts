/**
 * P3.3 — Out-of-Stock Operational Synchronization integration tests.
 *
 * Payment-time atomic decrement, concurrency (two competing payments), and
 * idempotent retry are ALREADY comprehensively covered by
 * tests/integration/inventory.test.ts — not duplicated here. This file
 * covers the NEW P3.3 surface: waiter menu availability composition
 * (advisory NEGATIVE/OUT/LOW/OK status, never a sales gate — P1.7),
 * addItem/updateItem/submit ALWAYS succeeding regardless of recorded stock
 * level (P1.7 audit "Allow negative inventory instead of blocking sales"),
 * replenish/adjust/write-off status sync, and location isolation for the
 * menu-availability query.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { ForbiddenError } from "@rcs/auth";
import { orders, menu, inventory, modifiers, reporting, billing } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  otherLocationId: string;
  tableId: string;
  trackedItemId: string; // "Pljeskavica", stock-tracked
  untrackedItemId: string; // "Voda", not tracked
  dodaciGroupId: string;
  kackavaljOptionId: string;
}

function ctx(fixture: Fixture, role: string, employeeId: string, permissions: string[], locationIds?: string[]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: locationIds ?? [fixture.locationId],
    roles: [role],
    permissions: new Set(permissions),
  };
}
function managerCtx(fixture: Fixture, employeeId = "mgr-1", locationIds?: string[]): AuthContext {
  return ctx(fixture, "MANAGER", employeeId, ["menu.view", "menu.manage", "shifts.manage", "orders.print", "inventory.view", "inventory.manage", "audit.view"], locationIds);
}
function waiterCtx(fixture: Fixture, employeeId = "waiter-1", locationIds?: string[]): AuthContext {
  return ctx(fixture, "WAITER", employeeId, ["menu.view", "shifts.manage", "orders.print"], locationIds);
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Stock sync tenant", slug: `stock-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD", timezone: "Europe/Belgrade" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Other" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  const otherFloor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, name: "Floor B" } });
  await prisma.restaurantTable.create({ data: { floorId: otherFloor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "mgr-1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, openedBy: "mgr-1" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Hrana", slug: `hrana-${randomUUID()}`, type: "FOOD" } });

  const trackedItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, price: "800.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const untrackedItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Voda", slug: `voda-${randomUUID()}`, price: "150.00", taxRate: "20", preparationStation: "NONE" },
  });

  const dodaciGroup = await prisma.modifierGroup.create({ data: { restaurantId: restaurant.id, name: "Dodaci", required: false, minSelect: 0, maxSelect: 5 } });
  const kackavaljOption = await prisma.modifierOption.create({ data: { modifierGroupId: dodaciGroup.id, name: "Kačkavalj", priceDelta: "100" } });
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: trackedItem.id, modifierGroupId: dodaciGroup.id } });

  return {
    restaurantId: restaurant.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    tableId: table.id,
    trackedItemId: trackedItem.id,
    untrackedItemId: untrackedItem.id,
    dodaciGroupId: dodaciGroup.id,
    kackavaljOptionId: kackavaljOption.id,
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("waiter menu availability composition", () => {
  it("returns OUT/LOW/OK for tracked items and null-status for untracked items, scoped to one location", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const inv = await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 3 });
    await inventory.setMinimumStock(manager, fixture.trackedItemId, 5); // 3 <= 5 => LOW

    const waiter = waiterCtx(fixture);
    const items = await menu.listMenuItems(waiter, { locationId: fixture.locationId });
    const tracked = items.find((i) => i.id === fixture.trackedItemId) as unknown as { stock: { trackingEnabled: boolean; stockStatus: string; currentStock: string } };
    const untracked = items.find((i) => i.id === fixture.untrackedItemId) as unknown as { stock: { trackingEnabled: boolean; stockStatus: string | null } };

    expect(tracked.stock.trackingEnabled).toBe(true);
    expect(tracked.stock.stockStatus).toBe("LOW");
    expect(Number(tracked.stock.currentStock)).toBe(3);
    expect(untracked.stock.trackingEnabled).toBe(false);
    expect(untracked.stock.stockStatus).toBeNull();

    void inv;
  });

  it("reports OUT at zero stock and OK above the minimum", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 0 });

    const waiter = waiterCtx(fixture);
    let items = await menu.listMenuItems(waiter, { locationId: fixture.locationId });
    let tracked = items.find((i) => i.id === fixture.trackedItemId) as unknown as { stock: { stockStatus: string } };
    expect(tracked.stock.stockStatus).toBe("OUT");

    await inventory.setMinimumStock(manager, fixture.trackedItemId, 2);
    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.trackedItemId, locationId: fixture.locationId } });
    await inventory.receiveStock(manager, invItem.id, { quantity: 20 });

    items = await menu.listMenuItems(waiter, { locationId: fixture.locationId });
    tracked = items.find((i) => i.id === fixture.trackedItemId) as unknown as { stock: { stockStatus: string } };
    expect(tracked.stock.stockStatus).toBe("OK");
  });

  it("location isolation: Location A stock=0 does not affect Location B availability, and a waiter cannot query a foreign location", async () => {
    const fixture = await createFixture();
    const bothLocationsManager = managerCtx(fixture, "mgr-both", [fixture.locationId, fixture.otherLocationId]);
    await inventory.initializeTracking(bothLocationsManager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 0 });
    await inventory.initializeTracking(bothLocationsManager, { menuItemId: fixture.trackedItemId, locationId: fixture.otherLocationId, initialStock: 10 });

    const waiterA = waiterCtx(fixture, "waiter-a", [fixture.locationId]);
    const itemsA = await menu.listMenuItems(waiterA, { locationId: fixture.locationId });
    const trackedA = itemsA.find((i) => i.id === fixture.trackedItemId) as unknown as { stock: { stockStatus: string } };
    expect(trackedA.stock.stockStatus).toBe("OUT");

    // Waiter A ne sme ni da zatraži tuđu lokaciju.
    await expect(menu.listMenuItems(waiterA, { locationId: fixture.otherLocationId })).rejects.toBeInstanceOf(ForbiddenError);

    const waiterB = waiterCtx(fixture, "waiter-b", [fixture.otherLocationId]);
    const itemsB = await menu.listMenuItems(waiterB, { locationId: fixture.otherLocationId });
    const trackedB = itemsB.find((i) => i.id === fixture.trackedItemId) as unknown as { stock: { stockStatus: string } };
    expect(trackedB.stock.stockStatus).toBe("OK"); // 10 na svojoj lokaciji, potpuno nezavisno od Lokacije A
  });

  it("admin list without a locationId stays unchanged (no stock field) — Menu admin regression", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 0 });

    const items = await menu.listMenuItems(manager, {});
    const tracked = items.find((i) => i.id === fixture.trackedItemId) as unknown as { stock?: unknown };
    expect(tracked.stock).toBeUndefined();
  });
});

describe("backend add-to-order validation", () => {
  it("P1.7: allows adding an OUT tracked item — recorded stock level never blocks a normal sale", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 0 });

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 1, modifierOptionIds: [] });
    expect(item).toBeDefined();

    // addItem never mutates currentStock — that stays exclusively Payment's job.
    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.trackedItemId, locationId: fixture.locationId } });
    expect(Number(invItem.currentStock)).toBe(0);
  });

  it("P1.7: allows a requested quantity above currently recorded stock", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 2 });

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 3, modifierOptionIds: [] });
    expect(item.quantity).toBe(3);
  });

  it("allows adding a LOW-stock item (still sellable)", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 2 });
    await inventory.setMinimumStock(manager, fixture.trackedItemId, 5); // 2 <= 5 => LOW, i dalje prodajno

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 1, modifierOptionIds: [] });
    expect(item).toBeDefined();
  });

  it("an untracked item is completely unaffected by stock rules", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.untrackedItemId, quantity: 50, modifierOptionIds: [] });
    expect(item.quantity).toBe(50);
  });

  it("P1.7: updateItem allows increasing quantity beyond recorded stock (never blocked), and always allows decreasing", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 3 });

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 2, modifierOptionIds: [] });

    await expect(orders.updateItem(waiter, order.id, item.id, { quantity: 10 })).resolves.toBeDefined();
    await expect(orders.updateItem(waiter, order.id, item.id, { quantity: 1 })).resolves.toBeDefined(); // smanjenje uvek dozvoljeno
  });
});

describe("submit-time validation (recheck, not decrement)", () => {
  it("P1.7: submit succeeds even when recorded stock became insufficient after the item was added to the draft — Payment remains the only decrement point", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const invItem = await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 2 });

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 2, modifierOptionIds: [] }); // validno u trenutku dodavanja

    // Zaliha se u međuvremenu smanjuje (npr. druga porudžbina je naplaćena).
    await inventory.adjustStock(manager, invItem.id, { delta: -1, reason: "Test: simulacija konkurentne prodaje" });

    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    expect(submitted.status).toBe("SUBMITTED");

    // Submit i dalje NIKAD ne dekrementira — to ostaje isključivo posao Payment-a.
    const movements = await prisma.inventoryMovement.findMany({ where: { menuItemId: fixture.trackedItemId, type: "SALE" } });
    expect(movements).toHaveLength(0);
  });

  it("P1.7: duplicate MenuItem lines with different P3.2 modifiers still aggregate correctly, but the aggregate no longer feeds any stock block — submit always succeeds", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 3 });

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    // Dve linije ISTOG artikla, različiti dodaci (P3.2 line-identity) — 2 + 2 = 4, zaliha je (namerno nedovoljna) 3.
    await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 2, modifierOptionIds: [fixture.kackavaljOptionId] });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 2, modifierOptionIds: [] });

    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    expect(submitted.status).toBe("SUBMITTED");
  });

  it("succeeds and does not decrement stock when availability holds — Payment remains the only decrement point", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 5 });

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 3, modifierOptionIds: [] });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    expect(submitted.status).toBe("SUBMITTED");
    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.trackedItemId, locationId: fixture.locationId } });
    expect(Number(invItem.currentStock)).toBe(5); // nepromenjeno — submit ne dekrementira
    const movements = await prisma.inventoryMovement.findMany({ where: { menuItemId: fixture.trackedItemId, type: "SALE" } });
    expect(movements).toHaveLength(0);
  });
});

describe("replenish/adjust/write-off synchronization", () => {
  it("P1.7: item is ALREADY addable at stock=0 (never blocked); 0 -> Receive +10 correctly clears the advisory OUT status, without touching MenuItem.isActive", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const invItem = await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 0 });

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    // P1.7: never blocked, even before any receipt.
    const firstItem = await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 1, modifierOptionIds: [] });
    expect(firstItem).toBeDefined();

    let items = await menu.listMenuItems(waiter, { locationId: fixture.locationId });
    let tracked = items.find((i) => i.id === fixture.trackedItemId) as unknown as { stock: { stockStatus: string } };
    expect(tracked.stock.stockStatus).toBe("OUT"); // advisory status still correctly reflects 0

    await inventory.receiveStock(manager, invItem.id, { quantity: 10 });

    items = await menu.listMenuItems(waiter, { locationId: fixture.locationId });
    tracked = items.find((i) => i.id === fixture.trackedItemId) as unknown as { stock: { stockStatus: string } };
    expect(tracked.stock.stockStatus).toBe("OK"); // advisory status correctly clears after receipt

    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 1, modifierOptionIds: [] });
    expect(item).toBeDefined();

    const menuItem = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.trackedItemId } });
    expect(menuItem.isActive).toBe(true); // nikad automatski izmenjeno
  });

  it("a write-off that empties stock makes the item OUT on the waiter menu", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const invItem = await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 5 });
    await inventory.writeOffStock(manager, invItem.id, { quantity: 5, reason: "Isteklo" });

    const waiter = waiterCtx(fixture);
    const items = await menu.listMenuItems(waiter, { locationId: fixture.locationId });
    const tracked = items.find((i) => i.id === fixture.trackedItemId) as unknown as { stock: { stockStatus: string } };
    expect(tracked.stock.stockStatus).toBe("OUT");
  });
});

describe("reporting integrity: a completed sale is counted normally even when it drove stock negative", () => {
  it("P1.7: a sale of an OUT (stock=0) item completes normally and IS counted as revenue — reporting is not broken by negative stock", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 0 });

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 1, modifierOptionIds: [] });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiter, submitted.id, { method: "CASH" });

    const summary = await reporting.getSalesSummary(manager, { locationId: "ALL", preset: "today" });
    expect(Number(summary.totalSales)).toBeGreaterThan(0);
    expect(summary.completedOrders).toBe(1);

    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.trackedItemId, locationId: fixture.locationId } });
    expect(Number(invItem.currentStock)).toBe(-1); // negative, and still counted correctly in reporting
  });
});

describe("modifier interaction (P3.2 decision preserved)", () => {
  it("modifier price/isActive is unaffected by inventory, and modifiers never independently decrement stock", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.trackedItemId, locationId: fixture.locationId, initialStock: 5 });

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.trackedItemId, quantity: 2, modifierOptionIds: [fixture.kackavaljOptionId] });
    expect(Number(item.price)).toBe(900); // 800 + 100, cena dodatka nepromenjena P3.3 izmenama

    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    expect(submitted.status).toBe("SUBMITTED");

    // Deaktiviranje opcije ne utiče na zalihu osnovnog artikla.
    await modifiers.setModifierOptionActive(manager, fixture.kackavaljOptionId, false);
    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.trackedItemId, locationId: fixture.locationId } });
    expect(Number(invItem.currentStock)).toBe(5); // i dalje nepromenjeno pre naplate
  });
});
