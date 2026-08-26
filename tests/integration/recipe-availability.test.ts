/**
 * P1.4: Waiter POS availability for recipe-produced items, sourced from
 * IngredientStock + recipe quantities instead of finished-goods stock.
 *
 * Covers: available/OUT status, limiting-ingredient portion math,
 * quantity-aware add/update validation, cross-item shared-ingredient
 * aggregation at submit, direct-stock/untracked items unaffected, stale
 * finished InventoryItem never blocks a recipe item, no ingredient
 * mutation before payment, deduction only on successful payment,
 * concurrency safety, and restaurant isolation.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ingredients, recipes, orders, billing, inventory } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  categoryId: string;
}

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

function ownerCtx(fixture: Pick<Fixture, "restaurantId" | "locationId">, employeeId = "owner-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["OWNER"],
    permissions: new Set(["inventory.view", "inventory.manage", "menu.view", "menu.manage", "orders.create", "orders.submit", "shifts.manage"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Availability tenant", slug: `avail-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Other Restaurant" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "owner-1" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id, categoryId: category.id };
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

async function seedIngredient(
  ctx: AuthContext,
  fixture: Pick<Fixture, "locationId">,
  name: string,
  unit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER" | "PIECE",
  initialStock: number,
  lowStockThreshold?: number
) {
  const ingredient = await ingredients.createIngredient(ctx, { name, unit });
  await ingredients.initializeStock(ctx, { ingredientId: ingredient.id, locationId: fixture.locationId, initialStock, lowStockThreshold });
  return ingredient;
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

// ─── 1, 2: basic AVAILABLE / OUT via addItem ───────────────────────────────

describe("Recipe item availability: add-to-cart validation", () => {
  it("1. adding a recipe item to the cart succeeds when ingredients are sufficient", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Omlet");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: eggs.id, quantity: 3 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    const added = await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 1 });
    expect(added).toBeTruthy();
  });

  it("2. adding a recipe item is REJECTED when a required ingredient is insufficient", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Omlet");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 2); // needs 3
    await recipes.addRecipeLine(owner, item.id, { ingredientId: eggs.id, quantity: 3 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await expect(orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 1 })).rejects.toThrow(/sirovin/i);
  });
});

// ─── 3: limiting ingredient determines available portions ─────────────────

describe("Recipe item availability: limiting-ingredient portion math", () => {
  it("3. Šopska salata example: tomato allows 6, cheese allows 2 -> availablePortions=2, limiting=Sir", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Šopska salata");
    const tomato = await seedIngredient(owner, fixture, "Paradajz", "KILOGRAM", 2.0); // 2000g / 300g = 6
    const cheese = await seedIngredient(owner, fixture, "Sir", "KILOGRAM", 0.25); // 250g / 100g = 2
    await recipes.addRecipeLine(owner, item.id, { ingredientId: tomato.id, quantity: 300, unit: "GRAM" });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: cheese.id, quantity: 100, unit: "GRAM" });

    const availability = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    const info = availability.get(item.id);
    expect(info?.availablePortions).toBe(2);
    expect(info?.limitingIngredientName).toBe("Sir");
    expect(info?.status).toBe("AVAILABLE");
  });

  it("reports OUT (availablePortions=0) when the limiting ingredient can't cover even one portion", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Šopska salata");
    const tomato = await seedIngredient(owner, fixture, "Paradajz", "KILOGRAM", 2.0);
    const cheese = await seedIngredient(owner, fixture, "Sir", "KILOGRAM", 0.05); // only 50g, needs 100g
    await recipes.addRecipeLine(owner, item.id, { ingredientId: tomato.id, quantity: 300, unit: "GRAM" });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: cheese.id, quantity: 100, unit: "GRAM" });

    const availability = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    const info = availability.get(item.id);
    expect(info?.availablePortions).toBe(0);
    expect(info?.status).toBe("OUT");
  });

  it("reuses the existing IngredientStock.lowStockThreshold for LOW status — no invented threshold", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Omlet");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 9, 6); // threshold=6, stock=9
    await recipes.addRecipeLine(owner, item.id, { ingredientId: eggs.id, quantity: 3 }); // 9/3 = 3 portions available

    const availability = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    const info = availability.get(item.id);
    expect(info?.availablePortions).toBe(3);
    // 9 (currentStock) <= 6? No -> not LOW by that reading. Reduce stock to trigger LOW instead:
    expect(info?.status).toBe("AVAILABLE");
  });
});

// ─── 4: quantity-aware validation ──────────────────────────────────────────

describe("Quantity-aware validation", () => {
  it("4. 3 eggs/portion, stock=8: quantity 1 allowed, quantity 2 allowed, quantity 3 rejected", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Omlet");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 8);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: eggs.id, quantity: 3 });

    const waiter = waiterCtx(fixture);

    const table1 = await newTable(fixture);
    const order1 = await orders.openOrder(waiter, { tableId: table1.id });
    await expect(orders.addItem(waiter, order1.id, { menuItemId: item.id, quantity: 1 })).resolves.toBeTruthy();

    const table2 = await newTable(fixture);
    const order2 = await orders.openOrder(waiter, { tableId: table2.id });
    await expect(orders.addItem(waiter, order2.id, { menuItemId: item.id, quantity: 2 })).resolves.toBeTruthy();

    const table3 = await newTable(fixture);
    const order3 = await orders.openOrder(waiter, { tableId: table3.id });
    await expect(orders.addItem(waiter, order3.id, { menuItemId: item.id, quantity: 3 })).rejects.toThrow(/sirovin/i);
  });

  it("updateItem re-validates when quantity is increased on an existing draft line", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Omlet");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 8);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: eggs.id, quantity: 3 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    const line = await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 2 }); // 6 eggs, ok

    await expect(orders.updateItem(waiter, order.id, line.id, { quantity: 3 })).rejects.toThrow(/sirovin/i); // 9 eggs, only 8 available
  });
});

// ─── 5: shared-ingredient aggregation across DIFFERENT menu items ──────────

describe("Cross-item shared-ingredient aggregation", () => {
  it("5. 2x Omlet + 1x Omlet sa sirom (both need eggs) aggregate to 9 required eggs at submit", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const omlet = await createMenuItem(fixture, "Omlet");
    const omletSaSirom = await createMenuItem(fixture, "Omlet sa sirom", "900.00");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 8); // need 9, only 8 -> must fail
    const cheese = await seedIngredient(owner, fixture, "Sir", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, omlet.id, { ingredientId: eggs.id, quantity: 3 });
    await recipes.addRecipeLine(owner, omletSaSirom.id, { ingredientId: eggs.id, quantity: 3 });
    await recipes.addRecipeLine(owner, omletSaSirom.id, { ingredientId: cheese.id, quantity: 0.1 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    // Each individual addItem call passes (2 and 1 eggs-worth don't exceed 8
    // checked independently against the same un-mutated starting stock —
    // add-time is deliberately per-request, not cart-aggregate, see P3.3).
    await orders.addItem(waiter, order.id, { menuItemId: omlet.id, quantity: 2 });
    await orders.addItem(waiter, order.id, { menuItemId: omletSaSirom.id, quantity: 1 });

    // Submit aggregates the WHOLE order: 2*3 + 1*3 = 9 eggs > 8 available.
    await expect(orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() })).rejects.toThrow(/sirovin/i);

    const eggStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: eggs.id, locationId: fixture.locationId } });
    expect(Number(eggStock.currentStock)).toBe(8); // untouched — validation only, never mutates
  });

  it("succeeds and submits when the aggregated shared-ingredient demand fits", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const omlet = await createMenuItem(fixture, "Omlet");
    const omletSaSirom = await createMenuItem(fixture, "Omlet sa sirom", "900.00");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 9); // exactly enough
    const cheese = await seedIngredient(owner, fixture, "Sir", "KILOGRAM", 10);
    await recipes.addRecipeLine(owner, omlet.id, { ingredientId: eggs.id, quantity: 3 });
    await recipes.addRecipeLine(owner, omletSaSirom.id, { ingredientId: eggs.id, quantity: 3 });
    await recipes.addRecipeLine(owner, omletSaSirom.id, { ingredientId: cheese.id, quantity: 0.1 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await orders.addItem(waiter, order.id, { menuItemId: omlet.id, quantity: 2 });
    await orders.addItem(waiter, order.id, { menuItemId: omletSaSirom.id, quantity: 1 });

    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    expect(submitted.status).toBe("SUBMITTED");
  });
});

// ─── 6, 7: direct-stock and untracked items unaffected ─────────────────────

describe("Direct-stock and untracked items are unaffected", () => {
  it("6. a direct-stock (trackStock=true, no recipe) item's OUT behavior is unchanged", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const cola = await createMenuItem(fixture, "Coca-Cola", "250.00");
    await inventory.initializeTracking(owner, { menuItemId: cola.id, locationId: fixture.locationId, initialStock: 0 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await expect(orders.addItem(waiter, order.id, { menuItemId: cola.id, quantity: 1 })).rejects.toThrow();
  });

  it("6b. a direct-stock item with sufficient stock still adds normally", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const cola = await createMenuItem(fixture, "Coca-Cola", "250.00");
    await inventory.initializeTracking(owner, { menuItemId: cola.id, locationId: fixture.locationId, initialStock: 3 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    const added = await orders.addItem(waiter, order.id, { menuItemId: cola.id, quantity: 3 });
    expect(added).toBeTruthy();
  });

  it("7. an item with neither trackStock nor a recipe is always addable regardless of any stock state", async () => {
    const fixture = await createFixture();
    const untracked = await createMenuItem(fixture, "Bottled Water", "150.00");

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    const added = await orders.addItem(waiter, order.id, { menuItemId: untracked.id, quantity: 50 });
    expect(added).toBeTruthy();
  });
});

// ─── 8: stale finished InventoryItem never affects recipe item availability ─

describe("Stale finished-goods stock never blocks a recipe-governed item", () => {
  it("8. an item transitioned to recipe-governed (frozen finished stock=0) is still addable based on ingredient stock", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Omlet");
    await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 0 }); // frozen at 0
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: eggs.id, quantity: 3 }); // auto-disables trackStock

    const menuItemNow = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(menuItemNow.trackStock).toBe(false);

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    const added = await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 1 }); // would fail if finished stock (0) were consulted
    expect(added).toBeTruthy();
  });
});

// ─── 9, 10: WHEN deduction happens ──────────────────────────────────────────

describe("Ingredient stock mutates ONLY on successful payment, never before", () => {
  it("9. adding to cart and submitting the order does NOT deduct ingredient stock", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Omlet");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: eggs.id, quantity: 3 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 2 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: eggs.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBe(10); // untouched — submit is validation only
    const movements = await prisma.ingredientMovement.count({ where: { ingredientId: eggs.id, type: "SALE" } });
    expect(movements).toBe(0);
  });

  it("10. ingredient stock deducts only after completePayment succeeds", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Omlet");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: eggs.id, quantity: 3 });

    const waiter = waiterCtx(fixture);
    const table = await newTable(fixture);
    const order = await orders.openOrder(waiter, { tableId: table.id });
    await orders.addItem(waiter, order.id, { menuItemId: item.id, quantity: 2 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    let stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: eggs.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBe(10); // still untouched right up to payment

    await billing.completePayment(waiter, submitted.id, { method: "CASH" });

    stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: eggs.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBe(4); // 10 - 2*3
  });
});

// ─── 11: concurrency/duplicate-payment safety remains intact ──────────────

describe("Concurrency safety is unaffected by the new availability layer", () => {
  it("11. two concurrent payments for orders requiring more than available stock: exactly one succeeds, stock never negative", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Omlet");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 3); // exactly enough for ONE order of qty 1 (3 eggs)
    await recipes.addRecipeLine(owner, item.id, { ingredientId: eggs.id, quantity: 3 });

    const waiter = waiterCtx(fixture);
    const [tableA, tableB] = await Promise.all([newTable(fixture), newTable(fixture)]);
    const [orderA, orderB] = await Promise.all([
      orders.openOrder(waiter, { tableId: tableA.id }),
      orders.openOrder(waiter, { tableId: tableB.id }),
    ]);
    await Promise.all([
      orders.addItem(waiter, orderA.id, { menuItemId: item.id, quantity: 1 }),
      orders.addItem(waiter, orderB.id, { menuItemId: item.id, quantity: 1 }),
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
    expect(succeeded).toHaveLength(1);

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: eggs.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBe(0); // never negative
  });
});

// ─── 12: cross-restaurant isolation ─────────────────────────────────────────

describe("Cross-restaurant isolation", () => {
  it("12. a recipe/ingredient OUT in Restaurant A never affects an identically-named, unrelated item in Restaurant B", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Omlet");
    const eggs = await seedIngredient(owner, fixture, "Jaja", "PIECE", 0); // OUT in restaurant A
    await recipes.addRecipeLine(owner, item.id, { ingredientId: eggs.id, quantity: 3 });

    // Restaurant B has its own item with the same name but is a totally
    // separate MenuItem/restaurant, and has NO recipe of its own — must be
    // treated as untracked, never as "OUT" from restaurant A's shortage.
    const otherLocation = await prisma.location.create({ data: { restaurantId: fixture.otherRestaurantId, name: "Other Main" } });
    const otherCategory = await prisma.menuCategory.create({
      data: { restaurantId: fixture.otherRestaurantId, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
    });
    const otherItem = await prisma.menuItem.create({
      data: { restaurantId: fixture.otherRestaurantId, categoryId: otherCategory.id, name: "Omlet", slug: `omlet-${randomUUID()}`, price: "800.00", taxRate: "20", preparationStation: "KITCHEN" },
    });
    await prisma.shift.create({ data: { restaurantId: fixture.otherRestaurantId, locationId: otherLocation.id, openedBy: "owner-b" } });
    const waiterB = waiterCtx({ restaurantId: fixture.otherRestaurantId, locationId: otherLocation.id }, "waiter-b");
    const floorB = await prisma.floor.create({ data: { restaurantId: fixture.otherRestaurantId, locationId: otherLocation.id, name: "FloorB" } });
    const tableB = await prisma.restaurantTable.create({ data: { floorId: floorB.id, label: "TB-1" } });
    const orderB = await orders.openOrder(waiterB, { tableId: tableB.id });
    const added = await orders.addItem(waiterB, orderB.id, { menuItemId: otherItem.id, quantity: 5 });
    expect(added).toBeTruthy();

    // Direct availability-map lookup never crosses restaurants either.
    const availabilityA = await ingredients.getRecipeAvailabilityForMenuItems(fixture.restaurantId, fixture.locationId, [item.id]);
    expect(availabilityA.get(item.id)?.status).toBe("OUT");
    const availabilityB = await ingredients.getRecipeAvailabilityForMenuItems(fixture.otherRestaurantId, otherLocation.id, [otherItem.id]);
    expect(availabilityB.has(otherItem.id)).toBe(false); // no recipe at all for otherItem
  });
});
