/**
 * Inventory Phase 2.5 — required integration acceptance (Section 27 of the
 * task spec). Proves the actual deduction chain end-to-end for the four
 * named fixtures the spec requires, using the EXISTING engine only
 * (orders.submitOrder -> billing.completePayment -> ingredient/inventory
 * deduction -> ledger -> balance), and proves Inventura reads the SAME
 * authoritative balance the sale path just wrote — no separate calculation,
 * no parallel engine. No schema change and no new domain function were
 * needed for any of this; every case below was already representable by
 * MenuItemIngredient / InventoryTrackingMethod / IngredientStock /
 * InventoryItem before Phase 2.5 — this test file is the proof, not a
 * consequence of new domain code.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ingredients, recipes, inventory, billing, orders, inventura } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  categoryId: string;
}

function ownerCtx(fixture: Fixture, employeeId = "owner-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["OWNER"],
    permissions: new Set([
      "inventory.view", "inventory.manage", "inventory.count",
      "menu.view", "menu.manage",
      "orders.create", "orders.manage", "orders.submit", "orders.print",
      "shifts.manage", "audit.view",
    ]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Phase2.5 tenant", slug: `p25-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Phase2.5 Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "owner-1" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  return { restaurantId: restaurant.id, locationId: location.id, categoryId: category.id };
}

async function createMenuItem(fixture: Fixture, name: string, station: "KITCHEN" | "BAR" = "KITCHEN", price = "500.00") {
  return prisma.menuItem.create({
    data: {
      restaurantId: fixture.restaurantId,
      categoryId: fixture.categoryId,
      name,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}`,
      price,
      taxRate: "20",
      preparationStation: station,
    },
  });
}

async function newTable(fixture: Fixture) {
  const floor = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: `Floor-${randomUUID()}` } });
  return prisma.restaurantTable.create({ data: { floorId: floor.id, label: `T-${randomUUID().slice(0, 6)}` } });
}

async function orderAndPay(ctx: AuthContext, fixture: Fixture, menuItemId: string, quantity: number) {
  const table = await newTable(fixture);
  const order = await orders.openOrder(ctx, { tableId: table.id });
  await orders.addItem(ctx, order.id, { menuItemId, quantity });
  const submitted = await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });
  return billing.completePayment(ctx, submitted.id, { method: "CASH" });
}

async function seedIngredient(ctx: AuthContext, fixture: Fixture, name: string, unit: "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER" | "PIECE", initialStock: number) {
  const ingredient = await ingredients.createIngredient(ctx, { name, unit });
  await ingredients.initializeStock(ctx, { ingredientId: ingredient.id, locationId: fixture.locationId, initialStock });
  return ingredient;
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("Phase 2.5 acceptance — A. Vinjak 0.04 (ŠANK, RECIPE, single ingredient, fractional liters)", () => {
  it("1 sold = exactly 0.04 L consumed", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Vinjak 0.04", "BAR");
    const vinjak = await seedIngredient(owner, fixture, "Vinjak", "LITER", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: vinjak.id, quantity: 0.04 });

    await orderAndPay(owner, fixture, item.id, 1);

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: vinjak.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(9.96, 9);
  });

  it("5 sold = exactly 0.20 L consumed", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Vinjak 0.04 (5x)", "BAR");
    const vinjak = await seedIngredient(owner, fixture, "Vinjak", "LITER", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: vinjak.id, quantity: 0.04 });

    await orderAndPay(owner, fixture, item.id, 5);

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: vinjak.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(9.8, 9);
  });

  it("25 sold = exactly 1.00 L consumed, no floating-point drift (Decimal-safe)", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Vinjak 0.04 (25x)", "BAR");
    const vinjak = await seedIngredient(owner, fixture, "Vinjak", "LITER", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: vinjak.id, quantity: 0.04 });

    await orderAndPay(owner, fixture, item.id, 25);

    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: vinjak.id, locationId: fixture.locationId } });
    // Exact equality, not toBeCloseTo — 25 * 0.04 = 1.00 must land EXACTLY
    // on Postgres Decimal(12,3), proving no native-JS-float accumulation
    // crept in anywhere on the recipe-quantity -> multiplication -> ledger
    // path (a drifted result would show as e.g. "8.99999999999999...").
    expect(stock.currentStock.toString()).toBe("9.000"); // 10 - 1.00, IngredientStock.currentStock is Decimal(12,3)
    expect(Number(stock.currentStock)).toBe(9);
  });
});

describe("Phase 2.5 acceptance — B. Coca-Cola (ŠANK, DIRECT_STOCK)", () => {
  it("1 sold = exactly 1 direct-stock unit deducted, Inventura reads the identical resulting balance", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Coca-Cola", "BAR");
    const invItem = await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 50, unit: "kom" });

    await orderAndPay(owner, fixture, item.id, 3);

    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(after.currentStock)).toBe(47); // 50 - 3, fixed 1:1 ratio confirmed by audit

    // Inventura consistency: addLines snapshots systemQtySnapshot directly
    // from InventoryItem.currentStock — same field, no recomputation.
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    const [lineId] = await inventura.addLines(owner, session.id, { targets: [{ targetType: "MENU_ITEM", menuItemId: item.id }] });
    const line = await prisma.inventoryCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(Number(line.systemQtySnapshot)).toBe(Number(after.currentStock));
  });
});

describe("Phase 2.5 acceptance — C. Punjena pljeskavica (KUHINJA, RECIPE, multi-ingredient food)", () => {
  it("2 sold = exactly 600g meso + 60g kačkavalj + 60g pršuta consumed", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Punjena pljeskavica", "KITCHEN");
    const meso = await seedIngredient(owner, fixture, "Roštilj meso", "GRAM", 10_000);
    const kackavalj = await seedIngredient(owner, fixture, "Kačkavalj", "GRAM", 5_000);
    const prsuta = await seedIngredient(owner, fixture, "Pršuta", "GRAM", 5_000);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: meso.id, quantity: 300 });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: kackavalj.id, quantity: 30 });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: prsuta.id, quantity: 30 });

    await orderAndPay(owner, fixture, item.id, 2);

    const mesoStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meso.id, locationId: fixture.locationId } });
    const kackaljStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: kackavalj.id, locationId: fixture.locationId } });
    const prsutaStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: prsuta.id, locationId: fixture.locationId } });
    expect(Number(mesoStock.currentStock)).toBeCloseTo(10_000 - 600, 9);
    expect(Number(kackaljStock.currentStock)).toBeCloseTo(5_000 - 60, 9);
    expect(Number(prsutaStock.currentStock)).toBeCloseTo(5_000 - 60, 9);
  });
});

describe("Phase 2.5 acceptance — D. multi-ingredient ŠANK cocktail (proves BAR + RECIPE uses the SAME engine as KUHINJA)", () => {
  it("sold cocktail deducts spirit A + spirit B + mixer exactly, and Inventura reads the identical resulting balances", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Cocktail", "BAR");
    const spiritA = await seedIngredient(owner, fixture, "Spirit A", "MILLILITER", 2000);
    const spiritB = await seedIngredient(owner, fixture, "Spirit B", "MILLILITER", 2000);
    const mixer = await seedIngredient(owner, fixture, "Mixer", "MILLILITER", 5000);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: spiritA.id, quantity: 40 });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: spiritB.id, quantity: 20 });
    await recipes.addRecipeLine(owner, item.id, { ingredientId: mixer.id, quantity: 100 });

    await orderAndPay(owner, fixture, item.id, 3);

    const spiritAStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: spiritA.id, locationId: fixture.locationId } });
    const spiritBStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: spiritB.id, locationId: fixture.locationId } });
    const mixerStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: mixer.id, locationId: fixture.locationId } });
    expect(Number(spiritAStock.currentStock)).toBeCloseTo(2000 - 120, 9); // 40ml * 3
    expect(Number(spiritBStock.currentStock)).toBeCloseTo(2000 - 60, 9);  // 20ml * 3
    expect(Number(mixerStock.currentStock)).toBeCloseTo(5000 - 300, 9);   // 100ml * 3

    // Inventura consistency for a multi-ingredient RECIPE item: each
    // ingredient's session line snapshot must equal the directly-queried
    // post-sale balance — same authoritative field, proven per-ingredient.
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    const lineIds = await inventura.addLines(owner, session.id, {
      targets: [
        { targetType: "INGREDIENT", ingredientId: spiritA.id },
        { targetType: "INGREDIENT", ingredientId: spiritB.id },
        { targetType: "INGREDIENT", ingredientId: mixer.id },
      ],
    });
    const lines = await prisma.inventoryCountLine.findMany({ where: { id: { in: lineIds } } });
    const byIngredient = new Map(lines.map((l) => [l.ingredientId, l]));
    expect(Number(byIngredient.get(spiritA.id)!.systemQtySnapshot)).toBe(Number(spiritAStock.currentStock));
    expect(Number(byIngredient.get(spiritB.id)!.systemQtySnapshot)).toBe(Number(spiritBStock.currentStock));
    expect(Number(byIngredient.get(mixer.id)!.systemQtySnapshot)).toBe(Number(mixerStock.currentStock));
  });
});

describe("Phase 2.5 acceptance — routing exclusivity (Section 14): a MenuItem never deducts through two paths at once", () => {
  it("BAR + RECIPE item produces zero InventoryMovement rows (RECIPE never also runs DIRECT_STOCK deduction)", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Vinjak routing check", "BAR");
    const vinjak = await seedIngredient(owner, fixture, "Vinjak routing", "LITER", 10);
    await recipes.addRecipeLine(owner, item.id, { ingredientId: vinjak.id, quantity: 0.04 });

    const result = await orderAndPay(owner, fixture, item.id, 1);

    const invMov = await prisma.inventoryMovement.findMany({ where: { menuItemId: item.id, orderId: result.order.id } });
    expect(invMov).toHaveLength(0);
  });

  it("BAR + DIRECT_STOCK item produces zero IngredientMovement rows (DIRECT_STOCK never also runs RECIPE deduction)", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createMenuItem(fixture, "Coca-Cola routing check", "BAR");
    await inventory.initializeTracking(owner, { menuItemId: item.id, locationId: fixture.locationId, initialStock: 20, unit: "kom" });

    const result = await orderAndPay(owner, fixture, item.id, 1);

    const ingMov = await prisma.ingredientMovement.findMany({ where: { restaurantId: fixture.restaurantId, orderId: result.order.id } });
    expect(ingMov).toHaveLength(0);
  });
});
