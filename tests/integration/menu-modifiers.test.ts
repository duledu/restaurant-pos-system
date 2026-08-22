/**
 * P3.2 — Menu Modifiers & Extras integration tests.
 *
 * Pure validation/pricing logic is already covered without a DB in
 * tests/unit/modifier-pricing.test.ts and tests/unit/order-cart.test.ts —
 * this file focuses on END-TO-END wiring through the real transaction flow:
 * Menu → Order → KDS → Payment → Receipt → Void → Reports → Inventory.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { ForbiddenError } from "@rcs/auth";
import { orders, billing, voids, production, modifiers, reporting, analytics, inventory } from "@rcs/domain";
import { computeOrderTotals } from "../../packages/domain/orders/order-totals";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  kitchenItemId: string; // "Pljeskavica" 800 RSD, Dodaci grupa vezana
  pizzaItemId: string; // "Pica" 900 RSD, Veličina (obavezna) grupa vezana
  dodaciGroupId: string;
  kackavaljOptionId: string; // +100
  slaninaOptionId: string; // +150
  velicinaGroupId: string; // required, single-select
  malaOptionId: string; // +0
  velikaOptionId: string; // +250
}

function ctx(fixture: Fixture, role: string, employeeId: string, permissions: string[]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(permissions),
  };
}
function managerCtx(fixture: Fixture, employeeId = "mgr-1"): AuthContext {
  return ctx(fixture, "MANAGER", employeeId, ["menu.view", "menu.manage", "audit.view", "shifts.manage", "orders.print", "production.view", "production.manage", "inventory.view", "inventory.manage"]);
}
function waiterCtx(fixture: Fixture, employeeId = "waiter-1"): AuthContext {
  return ctx(fixture, "WAITER", employeeId, ["menu.view", "shifts.manage", "orders.print"]);
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Modifiers tenant", slug: `mod-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD", timezone: "Europe/Belgrade" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "mgr-1" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Hrana", slug: `hrana-${randomUUID()}`, type: "FOOD" } });

  const kitchenItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, price: "800.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const pizzaItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pica", slug: `pica-${randomUUID()}`, price: "900.00", taxRate: "20", preparationStation: "KITCHEN" },
  });

  const dodaciGroup = await prisma.modifierGroup.create({
    data: { restaurantId: restaurant.id, name: "Dodaci", required: false, minSelect: 0, maxSelect: 5 },
  });
  const kackavaljOption = await prisma.modifierOption.create({ data: { modifierGroupId: dodaciGroup.id, name: "Kačkavalj", priceDelta: "100" } });
  const slaninaOption = await prisma.modifierOption.create({ data: { modifierGroupId: dodaciGroup.id, name: "Slanina", priceDelta: "150" } });

  const velicinaGroup = await prisma.modifierGroup.create({
    data: { restaurantId: restaurant.id, name: "Veličina", required: true, minSelect: 1, maxSelect: 1 },
  });
  const malaOption = await prisma.modifierOption.create({ data: { modifierGroupId: velicinaGroup.id, name: "Mala", priceDelta: "0" } });
  const velikaOption = await prisma.modifierOption.create({ data: { modifierGroupId: velicinaGroup.id, name: "Velika", priceDelta: "250" } });

  await prisma.menuItemModifierGroup.create({ data: { menuItemId: kitchenItem.id, modifierGroupId: dodaciGroup.id } });
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: pizzaItem.id, modifierGroupId: velicinaGroup.id } });

  return {
    restaurantId: restaurant.id,
    locationId: location.id,
    tableId: table.id,
    kitchenItemId: kitchenItem.id,
    pizzaItemId: pizzaItem.id,
    dodaciGroupId: dodaciGroup.id,
    kackavaljOptionId: kackavaljOption.id,
    slaninaOptionId: slaninaOption.id,
    velicinaGroupId: velicinaGroup.id,
    malaOptionId: malaOption.id,
    velikaOptionId: velikaOption.id,
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("admin CRUD: groups, options, attach/detach", () => {
  it("creates a group and option, attaches it to an item, and it appears in listModifierGroupsForItem", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const group = await modifiers.createModifierGroup(manager, { name: "Prilozi", required: false, minSelect: 0, maxSelect: 3, sortOrder: 0, isActive: true });
    const option = await modifiers.createModifierOption(manager, group.id, { name: "Bez luka", priceDelta: 0, sortOrder: 0, isActive: true });
    await modifiers.attachModifierGroupToItem(manager, fixture.pizzaItemId, group.id);

    const groups = await modifiers.listModifierGroupsForItem(manager, fixture.pizzaItemId);
    const attached = groups.find((g) => g.id === group.id);
    expect(attached).toBeDefined();
    expect(attached!.options.map((o) => o.id)).toContain(option.id);
  });

  it("detaching a group removes it from the item but does not delete the group itself", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await modifiers.detachModifierGroupFromItem(manager, fixture.kitchenItemId, fixture.dodaciGroupId);

    const groups = await modifiers.listModifierGroupsForItem(manager, fixture.kitchenItemId);
    expect(groups.find((g) => g.id === fixture.dodaciGroupId)).toBeUndefined();

    const stillExists = await prisma.modifierGroup.findUnique({ where: { id: fixture.dodaciGroupId } });
    expect(stillExists).not.toBeNull();
  });

  it("WAITER cannot manage modifiers (menu.manage required, same as Menu admin)", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    await expect(
      modifiers.createModifierGroup(waiter, { name: "X", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("order-time validation (server-side, end-to-end through orders.addItem)", () => {
  it("accepts a valid selection and prices it correctly", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.kackavaljOptionId] });
    expect(Number(item.price)).toBe(900); // 800 + 100
  });

  it("rejects an option that does not belong to a group attached to this item (cross-item tamper)", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    // velikaOption pripada Veličina grupi, koja NIJE vezana za kitchenItem.
    await expect(
      orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.velikaOptionId] })
    ).rejects.toThrow();
  });

  it("rejects a missing required-group selection", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await expect(
      orders.addItem(waiter, order.id, { menuItemId: fixture.pizzaItemId, quantity: 1, modifierOptionIds: [] })
    ).rejects.toThrow(/zahteva izbor/);
  });

  it("rejects an inactive option — cannot be newly ordered", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await modifiers.setModifierOptionActive(manager, fixture.kackavaljOptionId, false);

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await expect(
      orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.kackavaljOptionId] })
    ).rejects.toThrow(/nije dostupna/);
  });

  it("rejects exceeding a group's maxSelect", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await modifiers.updateModifierGroup(manager, fixture.dodaciGroupId, { maxSelect: 1 });

    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await expect(
      orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.kackavaljOptionId, fixture.slaninaOptionId] })
    ).rejects.toThrow(/najviše 1/);
  });

  it("regression: an item with no attached modifier groups still adds instantly with an empty selection", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const bareItem = await prisma.menuItem.create({
      data: { restaurantId: fixture.restaurantId, name: "Voda", slug: `voda-${randomUUID()}`, price: "150.00", taxRate: "20", preparationStation: "NONE" },
    });
    const item = await orders.addItem(waiter, order.id, { menuItemId: bareItem.id, quantity: 1, modifierOptionIds: [] });
    expect(Number(item.price)).toBe(150);
  });
});

describe("pricing", () => {
  it("base + one modifier = 900", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.kackavaljOptionId] });
    expect(Number(item.price)).toBe(900);
  });

  it("base + two modifiers = 1050", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, {
      menuItemId: fixture.kitchenItemId,
      quantity: 1,
      modifierOptionIds: [fixture.kackavaljOptionId, fixture.slaninaOptionId],
    });
    expect(Number(item.price)).toBe(1050);
  });

  it("quantity multiplies the effective (base+modifier) unit price: (800+100)×3 = 2700", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 3, modifierOptionIds: [fixture.kackavaljOptionId] });
    const totals = computeOrderTotals([item]);
    expect(totals.subtotal.toString()).toBe("2700");
  });

  it("a zero-price modifier does not change the price (800 + 0 = 800)", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.pizzaItemId, quantity: 1, modifierOptionIds: [fixture.malaOptionId] });
    expect(Number(item.price)).toBe(900); // pizza 900 + Mala(0)
  });

  it("historical price integrity: a paid order keeps its original +100 snapshot after the option's live price later changes to +150", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.kackavaljOptionId] });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    const { payment } = await billing.completePayment(waiter, submitted.id, { method: "CASH" }); // bez tenderedAmount -> server koristi tačan iznos

    // Cena opcije se sada menja u Admin panelu.
    await modifiers.updateModifierOption(manager, fixture.kackavaljOptionId, { priceDelta: 150 });

    expect(Number(payment.amount)).toBeCloseTo(900 * 1.2, 2); // 800+100=900, +20% porez
    const receipt = await prisma.receipt.findFirst({ where: { paymentId: payment.id } });
    const items = receipt!.items as unknown as { modifiers?: { name: string; priceDelta: string }[] }[];
    expect(items[0].modifiers?.[0].priceDelta).toBe("100"); // NE 150 — istorijski snapshot je nepromenjiv
  });

  it("submit-time re-snapshot: a modifier price change BEFORE submit is picked up (mirrors existing base-price refresh behavior)", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const draftItem = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.kackavaljOptionId] });
    expect(Number(draftItem.price)).toBe(900);

    await modifiers.updateModifierOption(manager, fixture.kackavaljOptionId, { priceDelta: 150 });

    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    expect(Number(submitted.items[0].price)).toBe(950); // 800 + 150 (osvežena cena dodatka)
  });
});

describe("order line identity: same item + different modifiers stay separate lines", () => {
  it("two addItem calls with different modifier sets create two distinct OrderItem rows", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item1 = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.kackavaljOptionId] });
    const item2 = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.slaninaOptionId] });
    expect(item1.id).not.toBe(item2.id);
    const full = await orders.getOrder(waiter, order.id);
    expect(full.items).toHaveLength(2);
  });

  it("updateItemModifiers safely edits a draft line's selection and recomputes price", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.kackavaljOptionId] });
    expect(Number(item.price)).toBe(900);

    const updated = await orders.updateItemModifiers(waiter, order.id, item.id, { modifierOptionIds: [fixture.kackavaljOptionId, fixture.slaninaOptionId] });
    expect(Number(updated.price)).toBe(1050);
    expect(updated.modifiers.map((m) => m.optionName).sort()).toEqual(["Kačkavalj", "Slanina"]);
  });
});

describe("KDS visibility", () => {
  it("modifiers appear on the kitchen station response for a submitted item", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, {
      menuItemId: fixture.kitchenItemId,
      quantity: 1,
      modifierOptionIds: [fixture.kackavaljOptionId, fixture.slaninaOptionId],
    });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const stationOrders = await production.listStationOrders(manager, fixture.locationId, "KITCHEN");
    expect(stationOrders).toHaveLength(1);
    const names = stationOrders[0].items[0].modifiers.map((m: { optionName: string }) => m.optionName).sort();
    expect(names).toEqual(["Kačkavalj", "Slanina"]);
  });
});

describe("void / partial-void with modifiers", () => {
  it("voiding a partial quantity removes value proportional to the EFFECTIVE (base+modifier) unit price, not base alone", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 3, modifierOptionIds: [fixture.kackavaljOptionId] });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const voidRecord = await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 1,
      reasonCode: "OTHER",
      explanation: "Gost je promenio mišljenje za jedan komad pre pripreme.",
    });
    expect(Number(voidRecord.voidedValue)).toBe(900); // 1 × (800+100), NE 800

    const remaining = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(remaining.quantity).toBe(2); // preostala količina i dalje nosi dodatke
    const remainingModifiers = await prisma.orderItemModifier.findMany({ where: { orderItemId: item.id } });
    expect(remainingModifiers).toHaveLength(1); // snapshot dodataka ostaje netaknut
  });

  it("voided modifier value is not counted as paid revenue", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const keptItem = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
    const voidedItem = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.kackavaljOptionId] });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(manager, submitted.id, voidedItem.id, { quantity: 1, reasonCode: "OTHER", explanation: "Gost je otkazao stavku sa dodatkom pre pripreme." });
    const { payment } = await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    expect(Number(payment.amount)).toBeCloseTo(800 * 1.2, 2); // SAMO zadržana stavka (bez dodatka)
    void keptItem;
  });
});

describe("Payment / Receipt reconciliation", () => {
  it("Payment amount includes the modifier delta exactly once, and the receipt shows the breakdown", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 2, modifierOptionIds: [fixture.kackavaljOptionId, fixture.slaninaOptionId] });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    const { payment, receipt } = await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    // (800 + 100 + 150) × 2 = 2100, + 20% porez = 2520
    expect(Number(payment.amount)).toBeCloseTo(2520, 2);
    expect(Number(receipt.total)).toBeCloseTo(Number(payment.amount), 2);

    const items = receipt.items as unknown as { basePrice?: string; modifiers?: { name: string; priceDelta: string }[]; lineTotal: string }[];
    expect(items[0].basePrice).toBe("800");
    expect(items[0].modifiers?.map((m) => m.name).sort()).toEqual(["Kačkavalj", "Slanina"]);
    expect(Number(items[0].lineTotal)).toBeCloseTo(2100, 2);
  });
});

describe("Reports reconciliation", () => {
  it("sales-by-item attributes the FULL (base+modifier) revenue to the parent item, not just the base price", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1, modifierOptionIds: [fixture.kackavaljOptionId, fixture.slaninaOptionId] });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiter, submitted.id, { method: "CASH" });

    const filters = { locationId: "ALL", preset: "today" } as const;
    const soldItems = await reporting.getSoldItems(manager, filters);
    const row = soldItems.rows.find((r) => r.name === "Pljeskavica");
    expect(row).toBeDefined();
    expect(Number(row!.totalRevenue)).toBeCloseTo(1050, 2); // 800+100+150, NE samo 800

    const categories = await analytics.getCategoryPerformance(manager, filters);
    const categoryRevenue = categories.categories.reduce((s, c) => s + Number(c.revenue), 0);
    expect(categoryRevenue).toBeCloseTo(1050, 2);
  });
});

describe("Inventory regression: modifiers do not create extra stock movements", () => {
  it("a paid item with modifiers decrements inventory exactly once (base MenuItem only), no modifier-driven movement", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.kitchenItemId, locationId: fixture.locationId, initialStock: 20 });

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 2, modifierOptionIds: [fixture.kackavaljOptionId] });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    const movements = await prisma.inventoryMovement.findMany({ where: { restaurantId: fixture.restaurantId, type: "SALE" } });
    expect(movements).toHaveLength(1); // JEDAN SALE red — dodaci ne prave sopstveni pokret zaliha
    expect(Number(movements[0].quantityDelta)).toBe(-2); // količina osnovnog artikla, ne uvećana zbog dodataka

    const invItem = await prisma.inventoryItem.findFirst({ where: { menuItemId: fixture.kitchenItemId, locationId: fixture.locationId } });
    expect(Number(invItem!.currentStock)).toBe(18); // 20 - 2
  });
});
