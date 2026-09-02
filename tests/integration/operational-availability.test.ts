/**
 * Kuhinja/Šank OPERATIVNA dostupnost ("NIJE DOSTUPNO") — vidi
 * packages/domain/menu/availability-service.ts za arhitekturu. Potpuno
 * nezavisno od InventoryItem/IngredientStock zalihe (samo upozorenje, nikad
 * blok) — ovaj model je jedini izvor tvrde blokade za NOVO naručivanje.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { ForbiddenError } from "@rcs/auth";
import { orders, availability, menu, inventory } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  tableId: string;
  biftekId: string; // KITCHEN
  colaId: string; // BAR
}

function context(fixture: Pick<Fixture, "restaurantId">, role: string, employeeId: string, locationIds: string[], permissions = new Set<string>()): AuthContext {
  return { userId: employeeId, employeeId, restaurantId: fixture.restaurantId, locationIds, roles: [role], permissions };
}
function kitchenCtx(fixture: Fixture, employeeId = "kitchen-1") {
  return context(fixture, "KITCHEN", employeeId, [fixture.locationId, fixture.otherLocationId], new Set(["menu.view", "production.view", "production.manage"]));
}
function barCtx(fixture: Fixture, employeeId = "bar-1") {
  return context(fixture, "BAR", employeeId, [fixture.locationId, fixture.otherLocationId], new Set(["menu.view", "production.view", "production.manage"]));
}
function managerCtx(fixture: Fixture, employeeId = "mgr-1") {
  return context(fixture, "MANAGER", employeeId, [fixture.locationId, fixture.otherLocationId], new Set(["menu.view", "production.view", "production.manage", "audit.view", "inventory.view", "inventory.manage"]));
}
function waiterCtx(fixture: Fixture, employeeId = "waiter-1") {
  return context(fixture, "WAITER", employeeId, [fixture.locationId, fixture.otherLocationId], new Set(["menu.view"]));
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Avail tenant", slug: `avail-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Branch" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "mgr-1" } });

  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" } });
  const biftek = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Biftek", slug: `biftek-${randomUUID()}`, price: "1200.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const cola = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Coca-Cola", slug: `cola-${randomUUID()}`, price: "300.00", taxRate: "20", preparationStation: "BAR" },
  });

  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id, otherLocationId: otherLocation.id, tableId: table.id, biftekId: biftek.id, colaId: cola.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("operational availability: RBAC", () => {
  it("KITCHEN can manage KITCHEN items", async () => {
    const fixture = await createFixture();
    const kitchen = kitchenCtx(fixture);
    const result = await availability.setAvailability(kitchen, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "OPREMA_KVAR" });
    expect(result.isAvailable).toBe(false);
  });

  it("KITCHEN cannot manage BAR items", async () => {
    const fixture = await createFixture();
    const kitchen = kitchenCtx(fixture);
    await expect(
      availability.setAvailability(kitchen, { locationId: fixture.locationId, menuItemId: fixture.colaId, isAvailable: false, reasonCode: "NEMA_PROIZVODA" })
    ).rejects.toThrow(ForbiddenError);
  });

  it("BAR can manage BAR items only", async () => {
    const fixture = await createFixture();
    const bar = barCtx(fixture);
    const ok = await availability.setAvailability(bar, { locationId: fixture.locationId, menuItemId: fixture.colaId, isAvailable: false, reasonCode: "NEMA_PROIZVODA" });
    expect(ok.isAvailable).toBe(false);

    await expect(
      availability.setAvailability(bar, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "DRUGO" })
    ).rejects.toThrow(ForbiddenError);
  });

  it("OWNER/ADMIN/MANAGER can manage both stations", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "DRUGO" });
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.colaId, isAvailable: false, reasonCode: "DRUGO" });
    const list = await availability.listAvailabilityForStation(manager, fixture.locationId, "KITCHEN");
    expect(list.find((i) => i.menuItemId === fixture.biftekId)?.isAvailable).toBe(false);
  });

  it("WAITER cannot manage availability at all", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    await expect(
      availability.setAvailability(waiter, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "DRUGO" })
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("operational availability: isolation", () => {
  it("is per-location — disabling at one location does not affect another", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "DRUGO" });

    const blockedHere = await availability.getBlockedAvailability(fixture.restaurantId, fixture.locationId, [fixture.biftekId]);
    const blockedThere = await availability.getBlockedAvailability(fixture.restaurantId, fixture.otherLocationId, [fixture.biftekId]);
    expect(blockedHere.has(fixture.biftekId)).toBe(true);
    expect(blockedThere.has(fixture.biftekId)).toBe(false);
  });

  it("rejects setting availability for a menu item belonging to another restaurant", async () => {
    const fixture = await createFixture();
    const foreignManager: AuthContext = {
      userId: "foreign-mgr", employeeId: "foreign-mgr", restaurantId: fixture.otherRestaurantId,
      locationIds: [fixture.locationId], roles: ["MANAGER"], permissions: new Set(["production.manage"]),
    };
    await expect(
      availability.setAvailability(foreignManager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "DRUGO" })
    ).rejects.toThrow("Artikal nije pronađen");
  });
});

describe("operational availability: waiter-facing effect", () => {
  it("an unavailable item remains VISIBLE in the menu listing, just flagged", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "OPREMA_KVAR" });

    const items = await menu.listMenuItems(manager, { locationId: fixture.locationId });
    const biftek = items.find((i) => i.id === fixture.biftekId);
    expect(biftek).toBeDefined();
    expect(biftek!.availability).toEqual({ isAvailable: false, reasonCode: "OPREMA_KVAR", reasonLabel: "Oprema / kvar" });
  });

  it("blocks addItem for an unavailable item with a clear error", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const waiter = waiterCtx(fixture);
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "NEMA_PROIZVODA" });

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await expect(orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1, modifierOptionIds: [] })).rejects.toThrow(/nedostupan/);
  });

  it("rejects a stale cart at submit time: item added before Kitchen disabled it", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const waiter = waiterCtx(fixture);

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1, modifierOptionIds: [] });

    // Kitchen disables AFTER the item was already added to the draft.
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "NEMA_SIROVINE_FIZICKI" });

    await expect(orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() })).rejects.toThrow(/Biftek/);

    // The order must remain DRAFT, unsent — no partial send happened.
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe("DRAFT");
  });

  it("does not touch an already-SUBMITTED order when the item is later disabled", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const waiter = waiterCtx(fixture);

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 2, modifierOptionIds: [] });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "DRUGO" });

    const reloadedItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: submitted.id } });
    expect(reloadedItem.status).toBe("SUBMITTED");
    expect(reloadedItem.quantity).toBe(2);
    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(reloadedOrder.status).toBe("SUBMITTED");
  });

  it("blocks increasing quantity of an already-cart item once disabled, but decreasing/removing still works", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const waiter = waiterCtx(fixture);

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 2, modifierOptionIds: [] });
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "DRUGO" });

    await expect(orders.updateItem(waiter, order.id, item.id, { quantity: 3 })).rejects.toThrow(/nedostupan/);
    await expect(orders.updateItem(waiter, order.id, item.id, { quantity: 1 })).resolves.toBeDefined();
  });

  it("re-enabling works immediately — addItem succeeds again right after", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const waiter = waiterCtx(fixture);

    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "DRUGO" });
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: true });

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await expect(orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1, modifierOptionIds: [] })).resolves.toBeDefined();
  });
});

describe("operational availability: independence from stock", () => {
  it("negative recorded stock + available => sale still allowed (stock is only a warning)", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const waiter = waiterCtx(fixture);

    await inventory.initializeTracking(manager, { menuItemId: fixture.biftekId, locationId: fixture.locationId, initialStock: 0 });
    // Force negative via a manual receive-then-adjust round trip is unnecessary here —
    // addItem never blocks on stock regardless of sign (P1.7), this just documents intent.
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await expect(orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1, modifierOptionIds: [] })).resolves.toBeDefined();
  });

  it("positive stock + operationally unavailable => still hard blocked", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const waiter = waiterCtx(fixture);

    await inventory.initializeTracking(manager, { menuItemId: fixture.biftekId, locationId: fixture.locationId, initialStock: 50 });
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "OPREMA_KVAR" });

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await expect(orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1, modifierOptionIds: [] })).rejects.toThrow(/nedostupan/);
  });

  it("availability changes never mutate InventoryItem.currentStock", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const invItem = await inventory.initializeTracking(manager, { menuItemId: fixture.biftekId, locationId: fixture.locationId, initialStock: 10 });

    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "DRUGO" });
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: true });

    const reloaded = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(reloaded.currentStock.toString()).toBe("10");
  });
});

describe("operational availability: audit", () => {
  it("records an audit entry with actor/location/reason/note on disable and on re-enable", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);

    await availability.setAvailability(manager, {
      locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: false, reasonCode: "NEMA_STRUJE_GASA", note: "Nestalo struje u kuhinji",
    });
    await availability.setAvailability(manager, { locationId: fixture.locationId, menuItemId: fixture.biftekId, isAvailable: true });

    const entries = await prisma.auditLog.findMany({
      where: { entityType: "MenuItemAvailability", entityId: fixture.biftekId },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("menu_item_availability.disabled");
    expect((entries[0].newValue as { reasonCode: string }).reasonCode).toBe("NEMA_STRUJE_GASA");
    expect((entries[0].newValue as { note: string }).note).toBe("Nestalo struje u kuhinji");
    expect(entries[0].userId).toBe("mgr-1");
    expect(entries[0].locationId).toBe(fixture.locationId);
    expect(entries[1].action).toBe("menu_item_availability.enabled");
  });
});
