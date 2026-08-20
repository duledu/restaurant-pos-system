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
import type { AuthContext } from "@rcs/auth";
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

    await inventory.setTrackingEnabled(ctx, fixture.menuItemId, false);

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

  it("decrementOnSale baca InsufficientStockError kada nema dovoljno zaliha", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 1,
    });

    await expect(
      inventory.decrementOnSale({
        paymentId: randomUUID(),
        orderId: randomUUID(),
        restaurantId: fixture.restaurantId,
        locationId: fixture.locationId,
        items: [{ menuItemId: fixture.menuItemId, quantity: 2 }],
      })
    ).rejects.toBeInstanceOf(inventory.InsufficientStockError);
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
    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 5,
    });

    await inventory.setTrackingEnabled(ctx, fixture.menuItemId, false);
    const mi = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(mi.trackStock).toBe(false);

    await inventory.setTrackingEnabled(ctx, fixture.menuItemId, true);
    const mi2 = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(mi2.trackStock).toBe(true);
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

  it("nedovoljne zalihe odbijaju placanje -- stock ostaje nepromenjen, placanje nije kreirano", async () => {
    const { fixture, waiter } = await setupTracked(1); // stock 1, order 2

    await expect(payTrackedOrder(fixture, waiter)).rejects.toBeInstanceOf(inventory.InsufficientStockError);

    // Zalihe nisu promenjene
    const invItem = await prisma.inventoryItem.findFirst({
      where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId },
    });
    expect(Number(invItem?.currentStock)).toBe(1);

    // Nema SALE kretanja
    const saleMovements = await prisma.inventoryMovement.findMany({
      where: { menuItemId: fixture.menuItemId, type: "SALE" },
    });
    expect(saleMovements).toHaveLength(0);

    // Nema naplate
    const payments = await prisma.payment.findMany({ where: { restaurantId: fixture.restaurantId } });
    expect(payments).toHaveLength(0);

    // Porudzbina nije COMPLETED
    const order = await prisma.order.findFirst({ where: { restaurantId: fixture.restaurantId } });
    expect(order?.status).not.toBe("COMPLETED");
  });

  it("vise artikala: ako jedan nema dovoljno zaliha, cela transakcija se rollback-uje", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);

    // Drugi artikal sa dovoljno zaliha
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
    await orders.addItem(waiter, order.id, { menuItemId: menuItem2.id, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await expect(
      billing.completePayment(waiter, submitted.id, { method: "CASH" })
    ).rejects.toBeInstanceOf(inventory.InsufficientStockError);

    // Item 1 ostaje na 10 (rollback)
    const inv1 = await prisma.inventoryItem.findFirst({ where: { menuItemId: fixture.menuItemId } });
    expect(Number(inv1?.currentStock)).toBe(10);

    // Item 2 ostaje na 0
    const inv2 = await prisma.inventoryItem.findFirst({ where: { menuItemId: menuItem2.id } });
    expect(Number(inv2?.currentStock)).toBe(0);

    // Bez SALE kretanja
    const saleMov = await prisma.inventoryMovement.findMany({
      where: { restaurantId: fixture.restaurantId, type: "SALE" },
    });
    expect(saleMov).toHaveLength(0);
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
    await inventory.setTrackingEnabled(ctx, fixture.menuItemId, false);

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

  it("pracen artikal bez zalihe na lokaciji odbija naplatu i ne dira drugu lokaciju", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const otherLocation = await prisma.location.create({
      data: { restaurantId: fixture.restaurantId, name: "Other" },
    });
    const otherInventory = await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: otherLocation.id,
      initialStock: 10,
    });

    await expect(payTrackedOrder(fixture, ctx)).rejects.toBeInstanceOf(inventory.InsufficientStockError);

    const unchanged = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: otherInventory.id } });
    expect(Number(unchanged.currentStock)).toBe(10);
    expect(await prisma.payment.count({ where: { restaurantId: fixture.restaurantId } })).toBe(0);
    expect(await prisma.inventoryMovement.count({
      where: { restaurantId: fixture.restaurantId, type: "SALE" },
    })).toBe(0);
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

  it("konkurentne prodaje iste kolicine -- samo jedna uspeva", async () => {
    const fixture = await createFixture();
    const ctx = ownerCtx(fixture);
    const waiter = ownerCtx(fixture);

    await inventory.initializeTracking(ctx, {
      menuItemId: fixture.menuItemId,
      locationId: fixture.locationId,
      initialStock: 2, // samo 2 komada
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

    // Konkurentne naplate
    const [r1, r2] = await Promise.allSettled([
      billing.completePayment(waiter, submitted1.id, { method: "CASH" }),
      billing.completePayment(waiter, submitted2.id, { method: "CASH" }),
    ]);

    const succeeded = [r1, r2].filter((r) => r.status === "fulfilled");
    const failed = [r1, r2].filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(inventory.InsufficientStockError);

    // Stock mora biti tacno 0 (nije negativan)
    const inv = await prisma.inventoryItem.findFirst({
      where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId },
    });
    expect(Number(inv?.currentStock)).toBe(0);

    // Tacno jedno SALE kretanje
    const saleMov = await prisma.inventoryMovement.findMany({
      where: { menuItemId: fixture.menuItemId, type: "SALE" },
    });
    expect(saleMov).toHaveLength(1);
  });
});
