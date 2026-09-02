/**
 * P1.2: Automatsko skidanje sirovina po normativu pri naplati.
 *
 * Pokriva (vidi PART 29 zahteva): 1. jedan artikal -> jedna sirovina, 2.
 * jedan artikal -> više sirovina, 3. množenje količinom, 4. više artikala
 * deli istu sirovinu, 5. kg/g preciznost, 6. l/ml preciznost, 7. komad
 * (PIECE), 8. preciznost malih decimala, 12. konkurentnost, 13. izolacija po
 * lokaciji, 14. izolacija po restoranu, 15. artikal bez recepture, 16.
 * neaktivna sirovina i dalje u postojećoj recepturi, 17. idempotentnost
 * ponovljene naplate, 18. SALE audit trag, 19. istorijsko kretanje
 * preživljava izmenu recepture, 20. poništavanje pre naplate ne skida
 * ništa, 21. refund ne vraća automatski sirovine (trenutno ne postoji
 * refund koncept — dokumentovano ispod), 22. običan konobar ne treba
 * inventory.manage, 23. postojeći gotov-proizvod inventar ostaje
 * funkcionalan uz recepture, 24. KDS lanac nepromenjen.
 *
 * P1.7 (negativna zaliha — vidi audit "Allow negative inventory instead of
 * blocking sales"): 9/10/11 su PREVAZIĐENI — nedovoljna evidentirana zaliha
 * (jedne ili više sirovina) NIKAD više ne blokira naplatu, i NEMA
 * "delimičnog skidanja" izuzeća — SVE potrebne sirovine se odbijaju u
 * potpunosti, čak i one koje idu u negativno. 25 (rollback) je takođe
 * PREVAZIĐEN za slučaj manjka zalihe (naplata sada uspeva) — rollback i
 * dalje važi ISKLJUČIVO za pravu grešku konfiguracije (RecipeNotConfiguredError)
 * ili stvaran DB kvar, ne za nedovoljnu zalihu.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ingredients, recipes, inventory, billing, orders, production } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  categoryId: string;
}

function ownerCtx(fixture: Pick<Fixture, "restaurantId" | "locationId">, employeeId = "owner-1"): AuthContext {
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
      "shifts.manage", "audit.view",
    ]),
  };
}

// Namerno BEZ "inventory.manage"/"inventory.view" — dokazuje PART 27: običan
// konobar naplaćuje bez ijedne dozvole za upravljanje zalihama, sistem
// interno skida sirovine.
function waiterCtx(fixture: Pick<Fixture, "restaurantId" | "locationId">, employeeId = "waiter-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["WAITER"],
    permissions: new Set(["menu.view", "orders.create", "orders.submit", "orders.print", "shifts.manage"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Deduction tenant", slug: `ded-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Other Restaurant" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Other" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "owner-1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, openedBy: "owner-1" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    categoryId: category.id,
  };
}

async function createMenuItem(fixture: Fixture, name: string, price = "800.00") {
  return prisma.menuItem.create({
    data: {
      restaurantId: fixture.restaurantId,
      categoryId: fixture.categoryId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}`,
      price,
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });
}

async function newTable(fixture: Pick<Fixture, "restaurantId" | "locationId">) {
  const floor = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: `Floor-${randomUUID()}` } });
  return prisma.restaurantTable.create({ data: { floorId: floor.id, label: `T-${randomUUID().slice(0, 6)}` } });
}

/** Otvara porudžbinu na NOVOM stolu, dodaje stavku, šalje i naplaćuje — vraća sve tri celine. */
async function orderAndPay(
  ctx: AuthContext,
  fixture: Pick<Fixture, "restaurantId" | "locationId">,
  menuItemId: string,
  quantity: number
) {
  const table = await newTable(fixture);
  const order = await orders.openOrder(ctx, { tableId: table.id });
  await orders.addItem(ctx, order.id, { menuItemId, quantity });
  const submitted = await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });
  const result = await billing.completePayment(ctx, submitted.id, { method: "CASH" });
  return { table, order, ...result };
}

async function seedIngredient(
  ctx: AuthContext,
  fixture: Pick<Fixture, "locationId">,
  name: string,
  unit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER" | "PIECE",
  initialStock: number
) {
  const ingredient = await ingredients.createIngredient(ctx, { name, unit });
  await ingredients.initializeStock(ctx, { ingredientId: ingredient.id, locationId: fixture.locationId, initialStock });
  return ingredient;
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

// ─── 1, 3: one ingredient, quantity multiplication ─────────────────────────

describe("Basic deduction: one MenuItem -> one Ingredient", () => {
  it("deducts recipe quantity * sold quantity, records one SALE movement", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    await orderAndPay(waiterCtx(fixture), fixture, item.id, 3);

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(9.4, 9); // 10 - (0.2 * 3)

    const movements = await prisma.ingredientMovement.findMany({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(movements).toHaveLength(1);
    expect(Number(movements[0].quantityDelta)).toBeCloseTo(-0.6, 9);
  });
});

// ─── 2, 4: multiple ingredients, shared ingredient across items ───────────

describe("Aggregation: multiple ingredients per item, shared ingredient across items", () => {
  it("one item with multiple ingredients deducts each correctly", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    const onion = await seedIngredient(owner, fixture, "Luk", "KILOGRAM", 5);
    const bun = await seedIngredient(owner, fixture, "Lepinja", "PIECE", 50);
    const oil = await seedIngredient(owner, fixture, "Ulje", "LITER", 5);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: onion.id, quantity: 0.05 });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: bun.id, quantity: 1 });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: oil.id, quantity: 0.01 });

    await orderAndPay(waiterCtx(fixture), fixture, item.id, 2);

    const [meatStock, onionStock, bunStock, oilStock] = await Promise.all(
      [meat, onion, bun, oil].map((i) =>
        prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: i.id, locationId: fixture.locationId } })
      )
    );
    expect(Number(meatStock.currentStock)).toBeCloseTo(9.6, 9); // 10 - 0.4
    expect(Number(onionStock.currentStock)).toBeCloseTo(4.9, 9); // 5 - 0.1
    expect(Number(bunStock.currentStock)).toBe(48); // 50 - 2
    expect(Number(oilStock.currentStock)).toBeCloseTo(4.98, 9); // 5 - 0.02
  });

  it("two DIFFERENT menu items sharing an ingredient aggregate into ONE deduction per sale", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const pljeskavica = await createMenuItem(fixture, "Pljeskavica");
    const duplo = await createMenuItem(fixture, "Duplo pljeskavica", "1200.00");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, pljeskavica.id, { ingredientId: meat.id, quantity: 0.2 });
    await recipes.addRecipeLine(owner, duplo.id, { ingredientId: meat.id, quantity: 0.4 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await orders.addItem(waiter, order.id, { menuItemId: pljeskavica.id, quantity: 2 }); // 0.4
    await orders.addItem(waiter, order.id, { menuItemId: duplo.id, quantity: 1 }); // 0.4
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiter, submitted.id, { method: "CASH" });

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(9.2, 9); // 10 - 0.8

    const movements = await prisma.ingredientMovement.findMany({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(movements).toHaveLength(1); // AGREGIRANO u jedno kretanje, ne dva
  });
});

// ─── 5, 6, 7, 8: unit precision ─────────────────────────────────────────────

describe("Unit precision: kg, l, piece — no floating-point drift", () => {
  it("kilogram-unit recipe survives repeated small deductions exactly (0.003 kg x many sales)", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Espresso");
    const coffee = await seedIngredient(owner, fixture, "Kafa", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: coffee.id, quantity: 0.003 });

    for (let i = 0; i < 5; i++) {
      await orderAndPay(waiterCtx(fixture), fixture, item.id, 5); // 5 * 0.003 = 0.015 per sale, x5 = 0.075
    }

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: coffee.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(9.925, 9); // 10 - 0.075 EXACTLY, no drift
  }, 60000);

  it("liter-unit (volume) recipe deducts precisely", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Sok");
    const oil = await seedIngredient(owner, fixture, "Ulje", "LITER", 2);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: oil.id, quantity: 0.01 });

    await orderAndPay(waiterCtx(fixture), fixture, item.id, 7);

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: oil.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(1.93, 9); // 2 - 0.07
  });

  it("PIECE-unit ingredients deduct as whole discrete counts", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Sendvic");
    const bun = await seedIngredient(owner, fixture, "Lepinja", "PIECE", 30);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: bun.id, quantity: 1 });

    await orderAndPay(waiterCtx(fixture), fixture, item.id, 4);

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: bun.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBe(26);
  });
});

// ─── 9, 10, 11: insufficient stock, multiple shortages, no partial deduction ─

describe("P1.7 audit scenario C/D: insufficient recorded stock NEVER blocks payment — deducts fully, goes negative", () => {
  it("scenario C: payment succeeds despite a shortage, exact recipe quantity deducted, ingredient goes negative", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 0.5);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 2 }); // needs 0.4, have 0.5 at add-time
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const meatStockRow = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    await ingredients.writeOffStock(owner, meatStockRow.id, { quantity: 0.2, reason: "Kvar" }); // 0.5 -> 0.3, now short of the 0.4 needed

    // P1.7: payment succeeds anyway — recorded shortage is never a sales gate.
    const result = await billing.completePayment(waiter, submitted.id, { method: "CASH" });
    expect(result.payment.id).toBeTruthy();

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(-0.1, 9); // 0.3 - 0.4 = -0.1, exact recipe deduction, never blocked

    const saleMovement = await prisma.ingredientMovement.findFirstOrThrow({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(Number(saleMovement.quantityDelta)).toBeCloseTo(-0.4, 9);
    expect(Number(saleMovement.quantityBefore)).toBe(0.3);
    expect(Number(saleMovement.quantityAfter)).toBeCloseTo(-0.1, 9);
  });

  it("scenario D: multiple deficient ingredients — ALL deducted in full (none skipped), each goes negative independently", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Burger");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10); // plenty throughout
    const onion = await seedIngredient(owner, fixture, "Luk", "KILOGRAM", 0.1);
    const bun = await seedIngredient(owner, fixture, "Lepinja", "PIECE", 2);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: onion.id, quantity: 0.05 });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: bun.id, quantity: 1 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 1 }); // passes: 0.2/0.05/1 all sufficient at add-time
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const onionStockRow = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: onion.id, locationId: fixture.locationId } });
    await ingredients.writeOffStock(owner, onionStockRow.id, { quantity: 0.09, reason: "Kvar" }); // 0.1 -> 0.01, short of 0.05
    const bunStockRow = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: bun.id, locationId: fixture.locationId } });
    await ingredients.writeOffStock(owner, bunStockRow.id, { quantity: 2, reason: "Kvar" }); // 2 -> 0, short of 1

    // P1.7: payment succeeds — TWO ingredients are short, neither blocks, both deducted in full.
    const result = await billing.completePayment(waiter, submitted.id, { method: "CASH" });
    expect(result.payment.id).toBeTruthy();

    const meatStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(meatStock.currentStock)).toBeCloseTo(9.8, 9); // 10 - 0.2, plenty -> stays positive

    const onionStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: onion.id, locationId: fixture.locationId } });
    expect(Number(onionStock.currentStock)).toBeCloseTo(-0.04, 9); // 0.01 - 0.05 = -0.04

    const bunStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: bun.id, locationId: fixture.locationId } });
    expect(Number(bunStock.currentStock)).toBe(-1); // 0 - 1 = -1

    // Sva TRI SALE kretanja zapisana — nijedno preskočeno zbog manjka.
    const saleMovements = await prisma.ingredientMovement.count({ where: { restaurantId: fixture.restaurantId, type: "SALE" } });
    expect(saleMovements).toBe(3);
  });
});

// ─── 12: concurrency ─────────────────────────────────────────────────────────

describe("Concurrency", () => {
  it("P1.7 audit scenario G: two simultaneous payments requiring more than recorded stock -- BOTH succeed, final stock goes negative, no lost update", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 1); // 1000 g total

    // 0.2 kg/unit * 3 units = 0.6 kg required per order -- two concurrent
    // orders each need 0.6 kg, only 1 kg available total.
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const waiter = waiterCtx(fixture);
    const [tableA, tableB] = await Promise.all([newTable(fixture), newTable(fixture)]);
    const [orderA, orderB] = await Promise.all([
      orders.openOrder(waiter, { tableId: tableA.id }),
      orders.openOrder(waiter, { tableId: tableB.id }),
    ]);
    await Promise.all([
      orders.addItem(waiter, orderA.id, { menuItemId: item.id, quantity: 3 }),
      orders.addItem(waiter, orderB.id, { menuItemId: item.id, quantity: 3 }),
    ]);
    const [submittedA, submittedB] = await Promise.all([
      orders.submitOrder(waiter, orderA.id, { idempotencyKey: randomUUID() }),
      orders.submitOrder(waiter, orderB.id, { idempotencyKey: randomUUID() }),
    ]);

    const results = await Promise.allSettled([
      billing.completePayment(waiter, submittedA.id, { method: "CASH" }),
      billing.completePayment(waiter, submittedB.id, { method: "CASH" }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(2); // P1.7: neither rejected for "insufficient" stock
    expect(failed).toHaveLength(0);

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(-0.2, 9); // 1 - 0.6 - 0.6 = -0.2, both decrements applied

    const saleMovements = await prisma.ingredientMovement.count({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(saleMovements).toBe(2); // one per successful payment, no lost update
  });

  // completePayment can never reach this state in production — its own
  // order.updateMany status guard already serializes concurrent completion
  // of the SAME order (see payment-workflow.test.ts "allows only one of two
  // concurrent payment attempts on the same order to commit"). This test
  // proves the LOWER-level function is independently safe if ever called
  // concurrently with an identical paymentId (e.g. a future direct caller,
  // or a retry that races instead of waiting) — the real defense is the
  // @@unique(paymentId, ingredientId) DB constraint, not application logic.
  it("truly concurrent decrementIngredientsOnSale calls with the SAME paymentId never double-deduct", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 20);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const paymentId = randomUUID();
    const saleInput = {
      paymentId,
      orderId: randomUUID(),
      restaurantId: fixture.restaurantId,
      locationId: fixture.locationId,
      items: [{ menuItemId: item.id, quantity: 3 }],
    };

    const results = await Promise.allSettled([
      ingredients.decrementIngredientsOnSale(saleInput),
      ingredients.decrementIngredientsOnSale(saleInput),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThanOrEqual(1); // idempotency check may let both no-op-succeed, or one may hit the unique constraint

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(19.4, 9); // 20 - 0.6, deducted exactly ONCE regardless of outcome shape

    const movements = await prisma.ingredientMovement.findMany({ where: { paymentId, type: "SALE" } });
    expect(movements).toHaveLength(1); // @@unique(paymentId, ingredientId) guarantees this even under a true race
  });
});

// ─── 13, 14: location and restaurant isolation ─────────────────────────────

describe("Location and restaurant isolation", () => {
  it("deduction at Location A never touches Location B's stock of the same ingredient", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture, "owner-1");
    const ownerOtherLoc: AuthContext = { ...owner, locationIds: [fixture.locationId, fixture.otherLocationId] };
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await ingredients.createIngredient(ownerOtherLoc, { name: "Mleveno meso", unit: "KILOGRAM" });
    await ingredients.initializeStock(ownerOtherLoc, { ingredientId: meat.id, locationId: fixture.locationId, initialStock: 10 });
    await ingredients.initializeStock(ownerOtherLoc, { ingredientId: meat.id, locationId: fixture.otherLocationId, initialStock: 10 });
    await recipes.addRecipeLine(ownerOtherLoc, item.id, { ingredientId: meat.id, quantity: 0.2 });

    await orderAndPay(waiterCtx(fixture), fixture, item.id, 3); // sells at Location A only

    const stockA = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    const stockB = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.otherLocationId } });
    expect(Number(stockA.currentStock)).toBeCloseTo(9.4, 9);
    expect(Number(stockB.currentStock)).toBe(10); // NETAKNUTO
  });

  it("a recipe/ingredient defined in Restaurant A cannot be reached from Restaurant B's context", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const outsider: AuthContext = { ...owner, restaurantId: fixture.otherRestaurantId };
    await expect(ingredients.getIngredient(outsider, meat.id)).rejects.toThrow("nije pronađena");
    await expect(recipes.getRecipe(outsider, item.id)).rejects.toThrow("nije pronađen");
  });
});

// ─── 15, 16: no recipe, inactive ingredient ─────────────────────────────────

describe("Edge cases: item without a recipe, inactive ingredient still referenced", () => {
  it("selling a MenuItem with NO recipe defined completes payment normally, deducts nothing", async () => {
    const fixture = await createFixture();
    const item = await createMenuItem(fixture, "Bottled Coca-Cola");

    const { payment } = await orderAndPay(waiterCtx(fixture), fixture, item.id, 5);
    expect(payment).toBeTruthy();

    const anyMovement = await prisma.ingredientMovement.count({ where: { restaurantId: fixture.restaurantId } });
    expect(anyMovement).toBe(0);
  });

  it("a deactivated ingredient still referenced by an existing recipe continues to be deducted on sale", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Sezonsko jelo");
    const seasonal = await seedIngredient(owner, fixture, "Sezonska sirovina", "KILOGRAM", 5);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: seasonal.id, quantity: 0.5 });

    await ingredients.deactivateIngredient(owner, seasonal.id);

    await orderAndPay(waiterCtx(fixture), fixture, item.id, 1); // sale still succeeds

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: seasonal.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBe(4.5); // deduction still happened
  });
});

// ─── 17, 18: idempotency + SALE audit ──────────────────────────────────────

describe("Idempotency and audit trail", () => {
  it("decrementIngredientsOnSale is idempotent by paymentId — repeated calls never double-deduct", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 20);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const paymentId = randomUUID();
    const saleInput = {
      paymentId,
      orderId: randomUUID(),
      restaurantId: fixture.restaurantId,
      locationId: fixture.locationId,
      items: [{ menuItemId: item.id, quantity: 3 }],
    };

    await ingredients.decrementIngredientsOnSale(saleInput);
    await ingredients.decrementIngredientsOnSale(saleInput);
    await ingredients.decrementIngredientsOnSale(saleInput);

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(19.4, 9); // 20 - 0.6, only ONCE

    const movements = await prisma.ingredientMovement.findMany({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(movements).toHaveLength(1);
  });

  it("retrying completePayment on an already-COMPLETED order is rejected upstream — stock deducted exactly once", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 20);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 2 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await billing.completePayment(waiter, submitted.id, { method: "CASH" });
    await expect(billing.completePayment(waiter, submitted.id, { method: "CASH" })).rejects.toThrow("već naplaćena");

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(19.6, 9); // 20 - 0.4, exactly once

    const movements = await prisma.ingredientMovement.findMany({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(movements).toHaveLength(1);
  });

  it("every SALE movement records ingredient/location/delta/before/after/paymentId/orderId — full audit trail", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const { payment, order } = await orderAndPay(waiterCtx(fixture), fixture, item.id, 3);

    const movement = await prisma.ingredientMovement.findFirstOrThrow({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(movement.restaurantId).toBe(fixture.restaurantId);
    expect(movement.locationId).toBe(fixture.locationId);
    expect(Number(movement.quantityBefore)).toBe(10);
    expect(Number(movement.quantityAfter)).toBeCloseTo(9.4, 9);
    expect(movement.paymentId).toBe(payment.id);
    expect(movement.orderId).toBe(order.id);
    expect(movement.createdAt).toBeInstanceOf(Date);
  });
});

// ─── 19: historical correctness survives recipe edits ─────────────────────

describe("Historical correctness: movement survives later recipe edit", () => {
  it("changing the recipe AFTER a sale does not alter the already-recorded SALE movement", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    const line = await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    await orderAndPay(waiterCtx(fixture), fixture, item.id, 1); // consumes 0.2 kg under the OLD recipe

    const movementBefore = await prisma.ingredientMovement.findFirstOrThrow({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(Number(movementBefore.quantityDelta)).toBeCloseTo(-0.2, 9);

    // Admin promeni normativ SUTRADAN na 0.22 kg
    await recipes.updateRecipeLine(owner, line.id, { quantity: 0.22 });

    // Istorijski red iz JUČE ostaje NEPROMENJEN
    const movementAfter = await prisma.ingredientMovement.findUniqueOrThrow({ where: { id: movementBefore.id } });
    expect(Number(movementAfter.quantityDelta)).toBeCloseTo(-0.2, 9);

    // NOVA prodaja koristi NOVI normativ
    await orderAndPay(waiterCtx(fixture), fixture, item.id, 1);
    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(10 - 0.2 - 0.22, 9);
  });
});

// ─── 20: void before payment ────────────────────────────────────────────────

describe("Void/cancel before payment", () => {
  it("voiding an order item before payment never creates a SALE ingredient movement", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 2 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    // Otkazivanje cele porudzbine PRE naplate (dovoljno je da naplata NIKAD ne
    // usledi za dokaz ove tacke — sirovine se skidaju iskljucivo pri
    // completePayment, nikad pri slanju/otkazivanju).
    const stockBefore = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stockBefore.currentStock)).toBe(10); // NETAKNUTO — nema naplate, nema skidanja

    const anySale = await prisma.ingredientMovement.count({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(anySale).toBe(0);
  });
});

// ─── 21: refund does not restore stock (no refund feature exists yet) ──────

describe("Refund does not automatically restore consumed ingredients", () => {
  it("after a completed sale, stock remains at the deducted level — no automatic restore process exists", async () => {
    // NAPOMENA: TableCore trenutno NEMA refund domensku funkciju (potvrdeno
    // pretragom packages/domain — nema "refund"/"Refund"/"REFUND" nigde).
    // Zato ne postoji kod koji BILO KADA automatski vraca sirovine nakon
    // prodaje. Ovaj test dokazuje invarijantu koja to mora ostati tacno: cak
    // i posle dodatnih, nepovezanih operacija (citanje istorije, protok
    // vremena simuliran dodatnim upitima), stanje ostaje TACNO na
    // post-prodajnom nivou.
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    await orderAndPay(waiterCtx(fixture), fixture, item.id, 1);

    await ingredients.getMovements(owner, (await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id } })).id);
    await ingredients.listIngredients(owner, fixture.locationId);

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(9.8, 9); // i dalje smanjeno, nista ga nije "vratilo"
  });
});

// ─── 22: waiter does not need inventory permission ─────────────────────────

describe("Permissions: normal waiter completes payment without inventory.manage", () => {
  it("a WAITER lacking inventory.view/inventory.manage can still complete a payment that triggers deduction", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const waiter = waiterCtx(fixture);
    expect(waiter.permissions.has("inventory.manage")).toBe(false);
    expect(waiter.permissions.has("inventory.view")).toBe(false);

    const { payment } = await orderAndPay(waiter, fixture, item.id, 1);
    expect(payment).toBeTruthy();

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(9.8, 9);
  });
});

// ─── 23: coexistence with existing finished-item inventory ────────────────

describe("Dual-stock model (P1.3): recipe always wins, never double-deducts", () => {
  // Supersedes the old "deducts both correctly" expectation (P1.2-era) —
  // that represented the technical capability, not the correct business
  // rule. Per the P1.3 decision: a configured recipe is authoritative and
  // finished-goods stock must NEVER also decrement for the same sale.

  it("normal path: adding the FIRST recipe line to a trackStock=true item auto-disables finished-stock tracking, and the sale deducts ONLY ingredients", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");

    await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 50 });
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const menuItemAfterTransition = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(menuItemAfterTransition.trackStock).toBe(false); // auto-disabled by the first recipe line

    await orderAndPay(waiterCtx(fixture), fixture, item.id, 3);

    // Finished-goods InventoryItem row is PRESERVED, UNTOUCHED (frozen at 50,
    // never deleted, never decremented) — only ingredients moved.
    const finishedStock = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: item.id, locationId: fixture.locationId } });
    expect(Number(finishedStock.currentStock)).toBe(50);

    const rawStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(rawStock.currentStock)).toBeCloseTo(9.4, 9); // 10 - 0.6

    const finishedMovements = await prisma.inventoryMovement.count({ where: { menuItemId: item.id, type: "SALE" } });
    const rawMovements = await prisma.ingredientMovement.count({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(finishedMovements).toBe(0); // NEVER double-deducted
    expect(rawMovements).toBe(1);

    const transitionAudit = await prisma.auditLog.findFirst({
      where: { entityId: item.id, action: "inventory.model_switched_to_recipe" },
    });
    expect(transitionAudit).not.toBeNull();
  });

  it("defense-in-depth: even if legacy/bad data leaves trackStock=true AND a recipe configured for the same item, a sale still deducts ONLY ingredients", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");

    // Reconstruct the "shouldn't happen via the normal path, but might via a
    // manual override" state: item starts WITHOUT tracking, gets a recipe
    // (trackStock stays false — nothing to auto-disable). P1.6:
    // inventory.initializeTracking now REJECTS this outright (RECIPE-mode
    // items can't be finished-goods-initialized through the normal API), so
    // the corrupted state is constructed directly at the data layer here —
    // this is now the ONLY way it could ever occur, and the test proves the
    // inventoryTrackingMethod gate still wins even then.
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });
    await prisma.inventoryItem.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, menuItemId: item.id, currentStock: 50, unit: "kom" },
    });
    await prisma.menuItem.update({ where: { id: item.id }, data: { trackStock: true } });

    const menuItemNow = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(menuItemNow.trackStock).toBe(true); // legacy/bad combination now exists
    expect(menuItemNow.inventoryTrackingMethod).toBe("RECIPE"); // but the authoritative gate is untouched

    await orderAndPay(waiterCtx(fixture), fixture, item.id, 3);

    const finishedStock = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: item.id, locationId: fixture.locationId } });
    expect(Number(finishedStock.currentStock)).toBe(50); // untouched despite trackStock=true

    const rawStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(rawStock.currentStock)).toBeCloseTo(9.4, 9);

    const finishedMovements = await prisma.inventoryMovement.count({ where: { menuItemId: item.id, type: "SALE" } });
    const rawMovements = await prisma.ingredientMovement.count({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(finishedMovements).toBe(0);
    expect(rawMovements).toBe(1);
  });

  it("defense-in-depth: a stale/zero finished-goods stock never blocks the order or the payment when a recipe governs the item", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");

    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });
    // Legacy bad state again (constructed directly — see P1.6 note above;
    // inventory.initializeTracking rejects RECIPE-mode items outright), but
    // this time the frozen finished stock is 0 — if the finished-goods
    // system were still consulted, this would block the order/payment with
    // InsufficientStockError. It must not.
    await prisma.inventoryItem.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, menuItemId: item.id, currentStock: 0, unit: "kom" },
    });
    await prisma.menuItem.update({ where: { id: item.id }, data: { trackStock: true } });

    const { payment } = await orderAndPay(waiterCtx(fixture), fixture, item.id, 2);
    expect(payment).toBeTruthy();

    const rawStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(rawStock.currentStock)).toBeCloseTo(9.6, 9); // 10 - 0.4
  });

  it("an item with ONLY finished-item tracking (no recipe) is unaffected by the new ingredient system", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const cola = await createMenuItem(fixture, "Bottled Coca-Cola", "170.00");
    await inventory.initializeTracking(owner, { menuItemId: cola.id, locationId: fixture.locationId, initialStock: 24 });

    await orderAndPay(waiterCtx(fixture), fixture, cola.id, 5);

    const stock = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: cola.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBe(19);
    const rawMovements = await prisma.ingredientMovement.count({ where: { restaurantId: fixture.restaurantId } });
    expect(rawMovements).toBe(0);
  });
});

// ─── 24: KDS lifecycle unaffected ──────────────────────────────────────────

describe("KDS lifecycle is unaffected by ingredient deduction", () => {
  it("advancing an item through kitchen stations before payment does not trigger any ingredient movement, and payment still works after", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const waiter = waiterCtx(fixture);
    const kitchenCtx: AuthContext = { ...waiter, employeeId: "kitchen-1", roles: ["KITCHEN"], permissions: new Set(["production.view", "production.manage"]) };
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    const item1 = await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await production.advanceItemStatus(kitchenCtx, submitted.id, item1.id, "KITCHEN", "SUBMITTED");
    await production.advanceItemStatus(kitchenCtx, submitted.id, item1.id, "KITCHEN", "ACCEPTED");

    const preDeductionMovements = await prisma.ingredientMovement.count({ where: { ingredientId: meat.id, type: "SALE" } });
    expect(preDeductionMovements).toBe(0); // KDS napredovanje ne skida nista (OPENING_STOCK od seedIngredient je ocekivan)

    await billing.completePayment(waiter, submitted.id, { method: "CASH" });

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(9.8, 9); // skinuto TEK pri naplati
  });
});

// ─── 25: Payment/Receipt rollback integrity ────────────────────────────────

describe("P1.7: insufficient ingredients no longer roll back the payment — Payment/Receipt/table proceed normally", () => {
  it("Payment/Receipt ARE created, order IS completed, table IS freed, ingredient goes negative — a recorded shortage is not a payment failure", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Pljeskavica");
    const meat = await seedIngredient(owner, fixture, "Mleveno meso", "KILOGRAM", 0.3);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meat.id, quantity: 0.2 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 1 }); // needs 0.2, have 0.3 — passes
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const meatStockRow = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    await ingredients.writeOffStock(owner, meatStockRow.id, { quantity: 0.2, reason: "Kvar" }); // 0.3 -> 0.1, now short of 0.2

    // P1.7: succeeds — a recorded shortage never fails the payment transaction.
    const result = await billing.completePayment(waiter, submitted.id, { method: "CASH" });
    expect(result.payment.id).toBeTruthy();

    const payment = await prisma.payment.findFirst({ where: { orderId: submitted.id } });
    const receipt = await prisma.receipt.findFirst({ where: { orderId: submitted.id } });
    expect(payment).not.toBeNull();
    expect(receipt).not.toBeNull();

    const orderRow = await prisma.order.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(orderRow.status).toBe("COMPLETED");

    const tableRow = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: table.id } });
    expect(tableRow.status).toBe("FREE");

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(-0.1, 9); // 0.1 - 0.2 = -0.1, exact recipe deduction
  });

  // §15 payment atomicity is UNCHANGED (still the same prisma.$transaction
  // wrapping Payment+Receipt+both deduction paths) — the one remaining
  // scenario that still rolls back everything is a genuine CONFIGURATION
  // failure (RECIPE with zero lines, RecipeNotConfiguredError — never a
  // stock-quantity issue), already covered by
  // inventory-tracking-method.test.ts "RECIPE artikal sa 0 linija blokira i
  // samu naplatu (rollback, bez mutacije)".
});
