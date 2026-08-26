/**
 * Integracioni testovi za sistem zaliha (Inventory).
 *
 * Pokriva:
 * - Inicijalizacija pracenja zaliha
 * - Primanje robe (RECEIPT)
 * - Korekcija (ADJUSTMENT)
 * - Otpis (WRITE_OFF)
 * - Odbitak pri prodaji (SALE) -- idempotentan po paymentId
 * - Blokada negativne korekcije/otpisa
 * - Pracenje historije kretanja
 * - Omogucavanje/onemogucavanje pracenja
 * - Transakciona integracija sa naplatom (billing)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { inventory, billing, orders, shifts } from "@rcs/domain";
import { ForbiddenError, type AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  menuItemId: string;
  tableId: string;
  shiftId: string;
}

function ownerCtx(fixture: Fixture, employeeId = "owner-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["OWNER"],
    permissions: new Set([
      "inventory.view", "inventory.manage",
      "menu.view", "menu.manage",
      "orders.create", "orders.manage", "orders.submit", "orders.print",
      "shifts.manage",
    ]),
  };
}

function waiterCtx(fixture: Fixture, employeeId = "waiter-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["WAITER"],
    permissions: new Set(["menu.view", "orders.create", "orders.submit", "orders.print"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Inv tenant", slug: `inv-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Inv Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  const shift = await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "owner-1" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Pice", slug: `pice-${randomUUID()}`, type: "DRINK" },
  });
  const menuItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Coca-Cola",
      slug: `coca-cola-${randomUUID()}`,
      price: "170",
      taxRate: "20",
      preparationStation: "BAR",
    },
  });
  return { restaurantId: restaurant.id, locationId: location.id, menuItemId: menuItem.id, tableId: table.id, shiftId: shift.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("inventory: inicijalizacija i osnove", () => {
  it("inicijalizuje pracenje zaliha sa pocetnim stanjem", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);

    const item = await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 20,
      unit: "boca",
    });

    expect(item.currentStock.toString()).toBe("20");
    expect(item.unit).toBe("boca");

    const movements = await inventory.getMovements(ctx, item.id);
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe("INITIAL");
    expect(Number(movements[0].quantityDelta)).toBe(20);

    const mi = await prisma.menuItem.findUnique({ where: { id: fixture.menuItemId } });
    expect(mi?.trackStock).toBe(true);
  });

  it("upsert -- ponovo inicijalizovana stavka ne kreira duplikat", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);

    await inventory.initializeTracking(ctx, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 10 });
    await inventory.initializeTracking(ctx, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 10 });

    const items = await prisma.inventoryItem.findMany({
      where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId },
    });
    expect(items).toHaveLength(1);
    expect(Number(items[0].currentStock)).toBe(10);

    const initialMovements = await prisma.inventoryMovement.findMany({
      where: { inventoryItemId: items[0].id, type: "INITIAL" },
    });
    expect(initialMovements).toHaveLength(1);
  });

  it("odbija inicijalizaciju sa negativnim pocetnim stanjem", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    await expect(
      inventory.initializeTracking(ctx, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: -5 })
    ).rejects.toThrow("negativno");
  });

  it("waiter bez inventory.manage ne moze inicijalizovati pracenje", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    await expect(
      inventory.initializeTracking(ctx, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 5 })
    ).rejects.toThrow();
  });
});

describe("inventory: location isolation", () => {
  it("blocks reads and mutations for an unauthorized location in the same restaurant", async () => {
    const fixture = await createFixture();
    const locationB = await prisma.location.create({
      data: { restaurantId: fixture.restaurantId, name: "Restricted branch" },
    });
    const fullAccess = ownerCtx(fixture);
    fullAccess.locationIds.push(locationB.id);
    const restricted = ownerCtx(fixture, "restricted-owner");
    restricted.permissions.add("inventory.opening_stock");

    const itemB = await inventory.initializeTracking(fullAccess, {
      menuItemId: fixture.menuItemId,
      locationId: locationB.id,
      initialStock: 10,
    });

    await expect(inventory.listInventory(restricted, locationB.id)).rejects.toThrow();
    await expect(inventory.getInventoryItem(restricted, itemB.id)).rejects.toThrow();
    await expect(inventory.getMovements(restricted, itemB.id)).rejects.toThrow();
    await expect(inventory.receiveStock(restricted, itemB.id, { quantity: 1 })).rejects.toThrow();
    await expect(
      inventory.bulkSetOpeningStock(restricted, {
        locationId: locationB.id,
        lines: [{ menuItemId: fixture.menuItemId, quantity: 20 }],
      })
    ).rejects.toThrow();

    const visible = await inventory.listInventory(restricted);
    expect(visible.some((item) => item.locationId === locationB.id)).toBe(false);
    const unchanged = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemB.id } });
    expect(Number(unchanged.currentStock)).toBe(10);
  });
});

describe("inventory: kretanja zaliha", () => {
  async function setup() {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const invItem = await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 10,
    });
    return { fixture, ctx, invItem };
  }

  it("prijem robe povecava stanje i kreira RECEIPT kretanje", async () => {
    const { ctx, invItem } = await setup();
    const result = await inventory.receiveStock(ctx, invItem.id, { quantity: 5, reason: "Dobavljac" });
    expect(result.after).toBe(15);
    expect(result.movement.type).toBe("RECEIPT");
    expect(Number(result.movement.quantityDelta)).toBe(5);
    expect(Number(result.movement.quantityBefore)).toBe(10);
    expect(Number(result.movement.quantityAfter)).toBe(15);
  });

  it("korekcija menja stanje (pozitivna i negativna)", async () => {
    const { ctx, invItem } = await setup();
    const r1 = await inventory.adjustStock(ctx, invItem.id, { delta: 3, reason: "Inventura" });
    expect(r1.after).toBe(13);
    expect(r1.movement.type).toBe("ADJUSTMENT");

    const r2 = await inventory.adjustStock(ctx, invItem.id, { delta: -2, reason: "Korekcija" });
    expect(r2.after).toBe(11);
  });

  it("otpis smanjuje stanje i kreira WRITE_OFF kretanje", async () => {
    const { ctx, invItem } = await setup();
    const result = await inventory.writeOffStock(ctx, invItem.id, { quantity: 3, reason: "Lom" });
    expect(result.after).toBe(7);
    expect(result.movement.type).toBe("WRITE_OFF");
  });

  it("otpis vise od dostupnog stanja se odbija", async () => {
    const { ctx, invItem } = await setup();
    await expect(
      inventory.writeOffStock(ctx, invItem.id, { quantity: 15, reason: "Previse" })
    ).rejects.toThrow();
  });

  it("negativna korekcija koja bi dovela do negativnog stanja se odbija", async () => {
    const { ctx, invItem } = await setup();
    await expect(
      inventory.adjustStock(ctx, invItem.id, { delta: -11, reason: "Previse" })
    ).rejects.toThrow();
  });

  it("historija kretanja prikazuje hronoloskim obrnutim redosledom", async () => {
    const { ctx, invItem } = await setup();
    await inventory.receiveStock(ctx, invItem.id, { quantity: 5 });
    await inventory.writeOffStock(ctx, invItem.id, { quantity: 2, reason: "Lom" });

    const movements = await inventory.getMovements(ctx, invItem.id);
    expect(movements.length).toBeGreaterThanOrEqual(3);
    expect(movements[0].type).toBe("WRITE_OFF");
  });

  it("konkurentni prijemi robe cuvaju tacan lanac before/after vrednosti", async () => {
    const { ctx, invItem } = await setup();

    await Promise.all([
      inventory.receiveStock(ctx, invItem.id, { quantity: 2 }),
      inventory.receiveStock(ctx, invItem.id, { quantity: 3 }),
    ]);

    const updated = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(updated.currentStock)).toBe(15);
    const receipts = await prisma.inventoryMovement.findMany({
      where: { inventoryItemId: invItem.id, type: "RECEIPT" },
      orderBy: { quantityBefore: "asc" },
    });
    expect(receipts).toHaveLength(2);
    expect(Number(receipts[0].quantityBefore)).toBe(10);
    expect(Number(receipts[0].quantityAfter)).toBe(Number(receipts[1].quantityBefore));
    expect(Number(receipts[1].quantityAfter)).toBe(15);
  });
});

describe("inventory: odbitak pri prodaji (decrementOnSale)", () => {
  it("prodaja smanjuje stanje i kreira SALE kretanje", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const invItem = await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 20,
    });

    const paymentId = randomUUID();
    await inventory.decrementOnSale({
      paymentId,
      orderId: randomUUID(),
      restaurantId: fixture.restaurantId,
      locationId: fixture.locationId,
      items: [{ menuItemId: fixture.menuItemId, quantity: 3 }],
    });

    const updated = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(updated.currentStock)).toBe(17);

    const movements = await prisma.inventoryMovement.findMany({
      where: { inventoryItemId: invItem.id, type: "SALE" },
    });
    expect(movements).toHaveLength(1);
    expect(Number(movements[0].quantityDelta)).toBe(-3);
    expect(movements[0].paymentId).toBe(paymentId);
  });

  it("isti paymentId ne kreira dvostruki odbitak (idempotentnost)", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 20,
    });

    const paymentId = randomUUID();
    const saleInput = {
      paymentId,
      orderId: randomUUID(),
      restaurantId: fixture.restaurantId,
      locationId: fixture.locationId,
      items: [{ menuItemId: fixture.menuItemId, quantity: 3 }],
    };

    await inventory.decrementOnSale(saleInput);
    await inventory.decrementOnSale(saleInput);
    await inventory.decrementOnSale(saleInput);

    const invItem = await prisma.inventoryItem.findFirst({
      where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId },
    });
    expect(Number(invItem?.currentStock)).toBe(17);

    const saleMovements = await prisma.inventoryMovement.findMany({
      where: { menuItemId: fixture.menuItemId, type: "SALE", paymentId },
    });
    expect(saleMovements).toHaveLength(1);
  });

  it("sabira vise redova istog artikla u jedan SALE odbitak", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 10,
    });

    const paymentId = randomUUID();
    await inventory.decrementOnSale({
      paymentId,
      orderId: randomUUID(),
      restaurantId: fixture.restaurantId,
      locationId: fixture.locationId,
      items: [
        { menuItemId: fixture.menuItemId, quantity: 1 },
        { menuItemId: fixture.menuItemId, quantity: 2 },
      ],
    });

    const invItem = await prisma.inventoryItem.findFirstOrThrow({
      where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId },
    });
    expect(Number(invItem.currentStock)).toBe(7);
    const movements = await prisma.inventoryMovement.findMany({ where: { paymentId, type: "SALE" } });
    expect(movements).toHaveLength(1);
    expect(Number(movements[0].quantityDelta)).toBe(-3);
  });

  it("artikal bez trackStock=true se ignorise u decrementOnSale", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const invItem = await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 10,
    });

    await inventory.setTrackingEnabled(ctx, fixture.menuItemId, false, { confirmSwitchAwayFromDirectStock: true });

    await inventory.decrementOnSale({
      paymentId: randomUUID(),
      orderId: randomUUID(),
      restaurantId: fixture.restaurantId,
      locationId: fixture.locationId,
      items: [{ menuItemId: fixture.menuItemId, quantity: 5 }],
    });

    const updated = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(updated.currentStock)).toBe(10);
  });

  it("null menuItemId u stavkama se ignorise", async () => {
    const fixture = await createFixture();
    await expect(
      inventory.decrementOnSale({
        paymentId: randomUUID(),
        orderId: randomUUID(),
        restaurantId: fixture.restaurantId,
        locationId: fixture.locationId,
        items: [{ menuItemId: null, quantity: 2 }],
      })
    ).resolves.toBeUndefined();
  });

  it("P1.7 audit scenario A/B: decrementOnSale NIKAD ne blokira zbog nedovoljne zalihe -- ide u negativno", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const invItem = await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 1,
    });

    // Scenario A: stock=1, sell 2 -> succeeds, stock = -1.
    await inventory.decrementOnSale({
      paymentId: randomUUID(),
      orderId: randomUUID(),
      restaurantId: fixture.restaurantId,
      locationId: fixture.locationId,
      items: [{ menuItemId: fixture.menuItemId, quantity: 2 }],
    });
    let after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(after.currentStock)).toBe(-1);

    // Scenario B: already negative (-1), sell 3 more -> -4.
    await inventory.decrementOnSale({
      paymentId: randomUUID(),
      orderId: randomUUID(),
      restaurantId: fixture.restaurantId,
      locationId: fixture.locationId,
      items: [{ menuItemId: fixture.menuItemId, quantity: 3 }],
    });
    after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(after.currentStock)).toBe(-4);

    const saleMovements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: invItem.id, type: "SALE" } });
    expect(saleMovements).toHaveLength(2);
  });

  it("restaurant scope ne moze promeniti zalihe drugog restorana", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const invItem = await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 10,
    });

    await inventory.decrementOnSale({
      paymentId: randomUUID(),
      orderId: randomUUID(),
      restaurantId: randomUUID(),
      locationId: fixture.locationId,
      items: [{ menuItemId: fixture.menuItemId, quantity: 2 }],
    });

    const unchanged = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(unchanged.currentStock)).toBe(10);
  });
});

describe("inventory: pracenje i minimum stanje", () => {
  it("setTrackingEnabled menja trackStock na MenuItem-u", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    // initialStock: 0 -- switching away and back never hits the P1.6 §19
    // stale-quantity guard (that's covered by its own dedicated test below),
    // so this test stays focused purely on the trackStock toggle itself.
    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 0,
    });

    await inventory.setTrackingEnabled(ctx, fixture.menuItemId, false);
    const mi = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(mi.trackStock).toBe(false);

    await inventory.setTrackingEnabled(ctx, fixture.menuItemId, true);
    const mi2 = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(mi2.trackStock).toBe(true);
  });

  it("re-enabling DIRECT_STOCK with a stale nonzero InventoryItem row requires confirmReactivateDirectStock, then zeroes it (never silently trusts the old number)", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const invItem = await inventory.initializeTracking(ctx, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 5 });
    await inventory.setTrackingEnabled(ctx, fixture.menuItemId, false, { confirmSwitchAwayFromDirectStock: true });

    await expect(inventory.setTrackingEnabled(ctx, fixture.menuItemId, true)).rejects.toBeInstanceOf(inventory.StaleDirectStockQuantityError);
    const stillOff = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(stillOff.trackStock).toBe(false);

    await inventory.setTrackingEnabled(ctx, fixture.menuItemId, true, { confirmReactivateDirectStock: true });
    const mi2 = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(mi2.trackStock).toBe(true);
    const zeroed = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(zeroed.currentStock)).toBe(0);
  });

  it("setMinimumStock azurira minimumStock na MenuItem-u", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 5,
    });

    await inventory.setMinimumStock(ctx, fixture.menuItemId, 3);
    const mi = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(Number(mi.minimumStock)).toBe(3);
  });

  it("setMinimumStock(null) uklanja prag — 'Prag nije podešen', item vise nije LOW", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    await inventory.initializeTracking(ctx, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 5 });
    await inventory.setMinimumStock(ctx, fixture.menuItemId, 10); // 5 <= 10 => LOW

    let status = await inventory.getStockStatusForMenuItems(fixture.restaurantId, fixture.locationId, [fixture.menuItemId]);
    expect(status.get(fixture.menuItemId)?.stockStatus).toBe("LOW");

    await inventory.setMinimumStock(ctx, fixture.menuItemId, null);
    const mi = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(mi.minimumStock).toBeNull();

    status = await inventory.getStockStatusForMenuItems(fixture.restaurantId, fixture.locationId, [fixture.menuItemId]);
    expect(status.get(fixture.menuItemId)?.stockStatus).toBe("OK"); // null prag nikad ne proizvodi LOW
  });

  it("rejects a negative threshold, but allows null", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    await inventory.initializeTracking(ctx, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 5 });

    await expect(inventory.setMinimumStock(ctx, fixture.menuItemId, -1)).rejects.toThrow("ne može biti negativna");
    await expect(inventory.setMinimumStock(ctx, fixture.menuItemId, null)).resolves.toBeUndefined();
  });

  it("setMinimumStock records an audit entry with previous and new threshold, including a clear-to-null transition", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    await inventory.initializeTracking(ctx, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 5 });

    await inventory.setMinimumStock(ctx, fixture.menuItemId, 3);
    const first = await prisma.auditLog.findFirst({
      where: { entityType: "MenuItem", entityId: fixture.menuItemId, action: "inventory.minimum_stock_changed" },
      orderBy: { createdAt: "desc" },
    });
    expect(first).toBeTruthy();
    expect((first?.newValue as { minimumStock: number | null })?.minimumStock).toBe(3);
    expect(first?.userId).toBe("owner-1");

    await inventory.setMinimumStock(ctx, fixture.menuItemId, null);
    const second = await prisma.auditLog.findFirst({
      where: { entityType: "MenuItem", entityId: fixture.menuItemId, action: "inventory.minimum_stock_changed" },
      orderBy: { createdAt: "desc" },
    });
    expect((second?.previousValue as { minimumStock: number | null })?.minimumStock).toBe(3);
    expect((second?.newValue as { minimumStock: number | null })?.minimumStock).toBeNull();
  });

  it("changing the threshold does NOT change currentStock and does NOT create an InventoryMovement", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const invItem = await inventory.initializeTracking(ctx, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 7 });

    const movementsBefore = await inventory.getMovements(ctx, invItem.id);

    await inventory.setMinimumStock(ctx, fixture.menuItemId, 4);
    await inventory.setMinimumStock(ctx, fixture.menuItemId, null);

    const stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(stock.currentStock)).toBe(7); // netaknuto

    const movementsAfter = await inventory.getMovements(ctx, invItem.id);
    expect(movementsAfter).toHaveLength(movementsBefore.length); // nijedno novo kretanje

    const mi = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(Number(mi.price)).toBeGreaterThan(0); // cena netaknuta (i dalje ono sto je bilo)
    expect(mi.isActive).toBe(true); // isActive netaknut
  });

  it("rejects a WAITER from changing the threshold", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const waiter = waiterCtx(fixture);
    await inventory.initializeTracking(ctx, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 5 });

    await expect(inventory.setMinimumStock(waiter, fixture.menuItemId, 2)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("inventory: transakciona integracija sa naplatom", () => {
  async function payTrackedOrder(fixture: Fixture, waiter: AuthContext, method: "CASH" | "CARD" = "CASH") {
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 2 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    return billing.completePayment(waiter, submitted.id, { method });
  }

  async function setupTracked(initialStock: number) {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const waiter = waiterCtx(fixture);
    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock,
    });
    return { fixture, ctx, waiter };
  }

  it("uspesna prodaja dekrementira zalihe u istoj transakciji kao naplata", async () => {
    const { fixture, waiter } = await setupTracked(20);

    const result = await payTrackedOrder(fixture, waiter);

    expect(result.payment.id).toBeTruthy();

    const invItem = await prisma.inventoryItem.findFirst({
      where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId },
    });
    expect(Number(invItem?.currentStock)).toBe(18); // 20 - 2

    const saleMovements = await prisma.inventoryMovement.findMany({
      where: { menuItemId: fixture.menuItemId, type: "SALE" },
    });
    expect(saleMovements).toHaveLength(1);
    expect(Number(saleMovements[0].quantityDelta)).toBe(-2);
    expect(saleMovements[0].paymentId).toBe(result.payment.id);
  });

  it("P1.7: nedovoljne (recorded) zalihe NIKAD ne odbijaju placanje -- placanje uspeva, stock ide u negativno", async () => {
    const { fixture, waiter } = await setupTracked(1); // stock 1, order 2

    const result = await payTrackedOrder(fixture, waiter);
    expect(result.payment.id).toBeTruthy();

    // Zaliha ide u negativno -- 1 - 2 = -1, nikad blokirano, nikad zaokruženo na 0.
    const invItem = await prisma.inventoryItem.findFirst({
      where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId },
    });
    expect(Number(invItem?.currentStock)).toBe(-1);

    // SALE kretanje JESTE zapisano.
    const saleMovements = await prisma.inventoryMovement.findMany({
      where: { menuItemId: fixture.menuItemId, type: "SALE" },
    });
    expect(saleMovements).toHaveLength(1);
    expect(Number(saleMovements[0].quantityDelta)).toBe(-2);
    expect(Number(saleMovements[0].quantityBefore)).toBe(1);
    expect(Number(saleMovements[0].quantityAfter)).toBe(-1);

    // Naplata JESTE kreirana.
    const payments = await prisma.payment.findMany({ where: { restaurantId: fixture.restaurantId } });
    expect(payments).toHaveLength(1);

    // Porudzbina JESTE COMPLETED.
    const order = await prisma.order.findFirst({ where: { restaurantId: fixture.restaurantId } });
    expect(order?.status).toBe("COMPLETED");
  });

  it("P1.7: vise artikala, jedan ima dovoljno a drugi nema -- OBA se prodaju, samo deficitarni ide u negativno", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);

    // Drugi artikal sa nedovoljno zaliha
    const category2 = await prisma.menuCategory.create({
      data: { restaurantId: fixture.restaurantId, name: "Hrana", slug: `hrana-${randomUUID()}`, type: "FOOD" },
    });
    const menuItem2 = await prisma.menuItem.create({
      data: {
        restaurantId: fixture.restaurantId,
        categoryId: category2.id,
        name: "Pivo",
        slug: `pivo-${randomUUID()}`,
        price: "250",
        taxRate: "20",
        preparationStation: "BAR",
      },
    });

    // Item 1: 10 zaliha (dovoljno za 2)
    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 10,
    });
    // Item 2: 0 zaliha (nedovoljno za 1)
    await inventory.initializeTracking(ctx, {
      menuItemId: menuItem2.id,
      locationId: fixture.locationId,
      initialStock: 0,
    });

    const waiter = ownerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 2 });

    // P1.7: addItem NIKAD ne blokira zbog recorded stock nivoa — Item2 (Pivo,
    // 0 zaliha) se dodaje bez problema, čak i pre bilo kakvog prijema robe.
    await orders.addItem(waiter, order.id, { menuItemId: menuItem2.id, quantity: 1 });

    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    const result = await billing.completePayment(waiter, submitted.id, { method: "CASH" });
    expect(result.payment.id).toBeTruthy();

    // Item 1: dovoljno zalihe -- normalan odbitak, 10 -> 8.
    const inv1 = await prisma.inventoryItem.findFirst({ where: { menuItemId: fixture.menuItemId } });
    expect(Number(inv1?.currentStock)).toBe(8);

    // Item 2: nedovoljno zalihe -- ipak prodato, 0 -> -1 (nikad blokirano).
    const inv2 = await prisma.inventoryItem.findFirst({ where: { menuItemId: menuItem2.id } });
    expect(Number(inv2?.currentStock)).toBe(-1);

    // OBA SALE kretanja zapisana.
    const saleMov = await prisma.inventoryMovement.findMany({
      where: { restaurantId: fixture.restaurantId, type: "SALE" },
    });
    expect(saleMov).toHaveLength(2);
  });

  it("nepracao artikal (trackStock=false) -- placanje prolazi normalno bez SALE kretanja", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const waiter = waiterCtx(fixture);

    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 5,
    });
    await inventory.setTrackingEnabled(ctx, fixture.menuItemId, false, { confirmSwitchAwayFromDirectStock: true });

    const result = await payTrackedOrder(fixture, waiter);

    expect(result.payment.id).toBeTruthy();
    // Zalihe nisu promenjene
    const inv = await prisma.inventoryItem.findFirst({ where: { menuItemId: fixture.menuItemId } });
    expect(Number(inv?.currentStock)).toBe(5);
    const saleMov = await prisma.inventoryMovement.findMany({
      where: { menuItemId: fixture.menuItemId, type: "SALE" },
    });
    expect(saleMov).toHaveLength(0);
  });

  it("P1.7/§12/§25: pracen artikal bez InventoryItem reda na lokaciji NIKAD ne odbija naplatu -- red se atomično kreira i ide negativno, druga lokacija netaknuta", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const otherLocation = await prisma.location.create({
      data: { restaurantId: fixture.restaurantId, name: "Other" },
    });
    // initializeTracking requires location access — use a setup ctx that covers both locations
    const setupCtx = { ...ctx, locationIds: [fixture.locationId, otherLocation.id] };
    const otherInventory = await inventory.initializeTracking(setupCtx, {
      menuItemId: fixture.menuItemId,
      locationId: otherLocation.id,
      initialStock: 10,
    });

    const result = await payTrackedOrder(fixture, ctx);
    expect(result.payment.id).toBeTruthy();

    // Druga lokacija ostaje POTPUNO netaknuta -- nikad "pozajmljena".
    const unchanged = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: otherInventory.id } });
    expect(Number(unchanged.currentStock)).toBe(10);

    // Na fixture.locationId, red je atomično kreiran i ide u negativno (0 - 2 = -2).
    const created = await prisma.inventoryItem.findFirstOrThrow({
      where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId },
    });
    expect(Number(created.currentStock)).toBe(-2);

    expect(await prisma.payment.count({ where: { restaurantId: fixture.restaurantId } })).toBe(1);
    expect(await prisma.inventoryMovement.count({
      where: { restaurantId: fixture.restaurantId, type: "SALE", locationId: fixture.locationId },
    })).toBe(1);
  });

  it("ponavljanje naplate (isti paymentId) -- zalihe se oduzimaju samo jednom", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const waiter = ownerCtx(fixture);

    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 10,
    });

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 2 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    // Prva naplata uspeva
    const result = await billing.completePayment(waiter, submitted.id, { method: "CASH" });

    // Ponavljanje (vec COMPLETED porudzbina) -- odbacuje se pre inventory-a
    await expect(
      billing.completePayment(waiter, submitted.id, { method: "CASH" })
    ).rejects.toThrow("već naplaćena");

    // Zalihe oduzete samo jednom
    const inv = await prisma.inventoryItem.findFirst({ where: { menuItemId: fixture.menuItemId } });
    expect(Number(inv?.currentStock)).toBe(8); // 10 - 2

    const saleMov = await prisma.inventoryMovement.findMany({
      where: { menuItemId: fixture.menuItemId, type: "SALE" },
    });
    expect(saleMov).toHaveLength(1);

    expect(result.payment.id).toBeTruthy();
  });

  it("P1.7 audit scenario F: konkurentne prodaje kada recorded stock nije dovoljan za obe -- OBE legitimne naplate uspevaju, stock ide u negativno, bez izgubljenog update-a", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const waiter = ownerCtx(fixture);

    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 2, // samo 2 komada -- nedovoljno za obe porudžbine od po 2
    });

    // Kreiraj drugu lokaciju i sto za drugu porudzbinu
    const floor2 = await prisma.floor.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "Floor2" },
    });
    const table2 = await prisma.restaurantTable.create({ data: { floorId: floor2.id, label: "T2" } });

    // Dve porudzbine, svaka naplacuje 2 komada (stock je samo 2)
    const order1 = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order1.id, { menuItemId: fixture.menuItemId, quantity: 2 });
    const submitted1 = await orders.submitOrder(waiter, order1.id, { idempotencyKey: randomUUID() });

    const order2 = await orders.openOrder(waiter, { tableId: table2.id });
    await orders.addItem(waiter, order2.id, { menuItemId: fixture.menuItemId, quantity: 2 });
    const submitted2 = await orders.submitOrder(waiter, order2.id, { idempotencyKey: randomUUID() });

    // Konkurentne naplate — P1.7: nijedna više ne sme biti odbijena zbog
    // "nedovoljne" zalihe (to više nije greška). Obe su legitimne prodaje.
    const [r1, r2] = await Promise.allSettled([
      billing.completePayment(waiter, submitted1.id, { method: "CASH" }),
      billing.completePayment(waiter, submitted2.id, { method: "CASH" }),
    ]);

    const succeeded = [r1, r2].filter((r) => r.status === "fulfilled");
    const failed = [r1, r2].filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(2);
    expect(failed).toHaveLength(0);

    // Stock: 2 - 2 - 2 = -2 -- oba odbitka primenjena, bez izgubljenog update-a.
    const inv = await prisma.inventoryItem.findFirst({
      where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId },
    });
    expect(Number(inv?.currentStock)).toBe(-2);

    // Tacno DVA SALE kretanja -- jedno po naplati, nijedno izgubljeno/duplirano.
    const saleMov = await prisma.inventoryMovement.findMany({
      where: { menuItemId: fixture.menuItemId, type: "SALE" },
    });
    expect(saleMov).toHaveLength(2);
    expect(saleMov.map((m) => Number(m.quantityDelta)).sort()).toEqual([-2, -2]);
  });
});
