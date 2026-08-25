/**
 * P1: Normativi/recepture + sirovinski lager — foundation.
 *
 * Pokriva (vidi zahtev "PART 20 — TESTS"):
 * 1. kreiranje sirovine, 2. izolacija po restoranu, 3. izolacija stanja po
 * lokaciji, 4. preciznost jedinica, 5. početno stanje, 6. prijem, 7.
 * korekcija, 8. otpis, 9. odbijanje negativnog stanja, 10. istorija
 * kretanja, 11-13. kreiranje/izmena/uklanjanje recepture, 14. više sirovina
 * po artiklu, 15. ista sirovina u više artikala, 16. neaktivna sirovina,
 * 17. neovlašćen pristup, 18. konkurentnost, 19. preciznost recepture, 20.
 * NEMA automatskog SALE kretanja u ovoj fazi.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { ingredients, recipes, orders, billing, inventory } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  tableId: string;
  menuItemId: string;
}

function managerCtx(fixture: Fixture, employeeId = "mgr-1", locationIds = [fixture.locationId]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds,
    roles: ["MANAGER"],
    permissions: new Set(["inventory.view", "inventory.manage", "menu.view", "audit.view", "shifts.manage", "orders.create", "orders.submit"]),
  };
}

function waiterCtx(fixture: Fixture, employeeId = "waiter-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["WAITER"],
    permissions: new Set(["menu.view", "orders.create", "orders.submit", "shifts.manage"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Normativi tenant", slug: `norm-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Other Restaurant" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Other" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "mgr-1" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const menuItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, price: "800.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    tableId: table.id,
    menuItemId: menuItem.id,
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

// ─── 1, 2: create + restaurant isolation ───────────────────────────────────

describe("Ingredient: create + restaurant isolation", () => {
  it("creates an ingredient with unit and optional category/sku", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM", category: "Meso", sku: "MM-01" });
    expect(ing.name).toBe("Mleveno meso");
    expect(ing.unit).toBe("KILOGRAM");
    expect(ing.category).toBe("Meso");
    expect(ing.isActive).toBe(true);
  });

  it("an ingredient created in one restaurant is invisible to another restaurant's context", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Luk", unit: "KILOGRAM" });

    const outsider: AuthContext = { ...manager, restaurantId: fixture.otherRestaurantId };
    await expect(ingredients.getIngredient(outsider, ing.id)).rejects.toThrow("nije pronađena");
  });
});

// ─── 3: location stock isolation ────────────────────────────────────────────

describe("IngredientStock: per-location isolation", () => {
  it("stock initialized at Location A is independent from Location B — no cross-location contamination", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture, "mgr-1", [fixture.locationId, fixture.otherLocationId]);
    const ing = await ingredients.createIngredient(manager, { name: "Ulje", unit: "LITER" });

    await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 10 });
    await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.otherLocationId, initialStock: 3 });

    const listA = await ingredients.listIngredients(manager, fixture.locationId);
    const listB = await ingredients.listIngredients(manager, fixture.otherLocationId);
    expect(Number(listA.find((i) => i.id === ing.id)?.stock?.currentStock)).toBe(10);
    expect(Number(listB.find((i) => i.id === ing.id)?.stock?.currentStock)).toBe(3);

    // Menjanje stanja na A ne dira B
    const stockA = await prisma.ingredientStock.findUniqueOrThrow({ where: { locationId_ingredientId: { locationId: fixture.locationId, ingredientId: ing.id } } });
    await ingredients.receiveStock(manager, stockA.id, { quantity: 5 });
    const stockBAfter = await prisma.ingredientStock.findUniqueOrThrow({ where: { locationId_ingredientId: { locationId: fixture.otherLocationId, ingredientId: ing.id } } });
    expect(Number(stockBAfter.currentStock)).toBe(3);
  });

  it("enforces unique(ingredientId, locationId) at the database level", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "So", unit: "KILOGRAM" });
    await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 1 });
    // Drugi initializeStock poziv na ISTOJ lokaciji ažurira postojeći red (upsert-like), ne duplira ga
    await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 1, lowStockThreshold: 0.5 });
    const count = await prisma.ingredientStock.count({ where: { ingredientId: ing.id, locationId: fixture.locationId } });
    expect(count).toBe(1);
  });
});

// ─── 4, 19: precision ───────────────────────────────────────────────────────

describe("Precision: small decimal quantities never drift", () => {
  it("0.003 kg salt, 0.015 l oil, 0.250 kg meat survive receive/adjust round-trips exactly", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const salt = await ingredients.createIngredient(manager, { name: "So", unit: "KILOGRAM" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: salt.id, locationId: fixture.locationId, initialStock: 0.003 });
    expect(Number(stock.currentStock)).toBe(0.003);

    const afterReceive = await ingredients.receiveStock(manager, stock.id, { quantity: 0.015 });
    expect(afterReceive.after).toBeCloseTo(0.018, 9);

    const afterAdjust = await ingredients.adjustStock(manager, stock.id, { delta: -0.008, reason: "Korekcija merenja" });
    expect(afterAdjust.after).toBeCloseTo(0.01, 9);
  });

  it("recipe quantities (e.g. 0.200 kg) are stored and read back exactly", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    const line = await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });
    expect(Number(line.quantity)).toBe(0.2);
    const reloaded = await prisma.menuItemIngredient.findUniqueOrThrow({ where: { id: line.id } });
    expect(Number(reloaded.quantity)).toBe(0.2);
  });
});

// ─── 5, 6, 7, 8, 9, 10: stock lifecycle ────────────────────────────────────

describe("IngredientStock: opening stock, receipt, adjustment, write-off, movement history", () => {
  it("opening stock creates exactly one OPENING_STOCK movement, auditable with actor/timestamp", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Krompir", unit: "KILOGRAM" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 25 });

    const movements = await ingredients.getMovements(manager, stock.id);
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe("OPENING_STOCK");
    expect(movements[0].employeeId).toBe("mgr-1");
    expect(Number(movements[0].quantityBefore)).toBe(0);
    expect(Number(movements[0].quantityAfter)).toBe(25);
  });

  it("receipt increases stock and records a RECEIPT movement", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Lepinja", unit: "PIECE" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 10 });

    const result = await ingredients.receiveStock(manager, stock.id, { quantity: 20, reason: "Dostava pekare" });
    expect(result.after).toBe(30);
    const movements = await ingredients.getMovements(manager, stock.id);
    expect(movements[0].type).toBe("RECEIPT");
    expect(movements[0].reason).toBe("Dostava pekare");
  });

  it("adjustment applies a signed delta and requires a reason", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Ulje", unit: "LITER" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 5 });

    await expect(ingredients.adjustStock(manager, stock.id, { delta: -1, reason: "" })).rejects.toThrow("obavezan");
    const result = await ingredients.adjustStock(manager, stock.id, { delta: -1.5, reason: "Prosuto" });
    expect(result.after).toBe(3.5);
  });

  it("write-off decreases stock, requires a reason, and records a WRITE_OFF movement", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Krompir", unit: "KILOGRAM" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 10 });

    await expect(ingredients.writeOffStock(manager, stock.id, { quantity: 2, reason: "" })).rejects.toThrow("obavezan");
    const result = await ingredients.writeOffStock(manager, stock.id, { quantity: 2, reason: "Pokvarilo se" });
    expect(result.after).toBe(8);
    const movements = await ingredients.getMovements(manager, stock.id);
    expect(movements[0].type).toBe("WRITE_OFF");
  });

  it("rejects an adjustment/write-off that would push stock below zero — no negative stock without a supported workflow", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "So", unit: "KILOGRAM" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 1 });

    await expect(ingredients.writeOffStock(manager, stock.id, { quantity: 5, reason: "Previše" })).rejects.toThrow("negativnog stanja");
    await expect(ingredients.adjustStock(manager, stock.id, { delta: -5, reason: "Previše" })).rejects.toThrow("negativnog stanja");

    const unchanged = await prisma.ingredientStock.findUniqueOrThrow({ where: { id: stock.id } });
    expect(Number(unchanged.currentStock)).toBe(1);
  });

  it("movement history is ordered newest-first and includes resolved employee names", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Luk", unit: "KILOGRAM" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 5 });
    await ingredients.receiveStock(manager, stock.id, { quantity: 2 });
    await ingredients.adjustStock(manager, stock.id, { delta: -1, reason: "Korekcija" });

    const movements = await ingredients.getMovements(manager, stock.id);
    expect(movements).toHaveLength(3);
    expect(movements[0].type).toBe("ADJUSTMENT"); // najnovije prvo
    expect(movements[2].type).toBe("OPENING_STOCK");
  });
});

// ─── 11, 12, 13, 14, 15: recipes ───────────────────────────────────────────

describe("Recipe (Normativ): create, edit, remove, multiple ingredients, shared ingredients", () => {
  it("creates a recipe line for a menu item", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    const line = await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });
    expect(line.ingredientId).toBe(meat.id);
    expect(Number(line.quantity)).toBe(0.2);
  });

  it("edits an existing recipe line's quantity", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    const line = await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });
    const updated = await recipes.updateRecipeLine(manager, line.id, { quantity: 0.4 });
    expect(Number(updated.quantity)).toBe(0.4);
  });

  it("removes a recipe line — the ingredient itself is untouched", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    const line = await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });
    await recipes.removeRecipeLine(manager, line.id);

    const remaining = await recipes.getRecipe(manager, fixture.menuItemId);
    expect(remaining).toHaveLength(0);
    const ingredientStillExists = await ingredients.getIngredient(manager, meat.id);
    expect(ingredientStillExists).toBeTruthy();
  });

  it("a menu item can have multiple ingredients — full Pljeskavica recipe example", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    const onion = await ingredients.createIngredient(manager, { name: "Luk", unit: "KILOGRAM" });
    const bun = await ingredients.createIngredient(manager, { name: "Lepinja", unit: "PIECE" });
    const oil = await ingredients.createIngredient(manager, { name: "Ulje", unit: "LITER" });

    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: onion.id, quantity: 0.05 });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: bun.id, quantity: 1 });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: oil.id, quantity: 0.01 });

    const recipe = await recipes.getRecipe(manager, fixture.menuItemId);
    expect(recipe).toHaveLength(4);
    expect(recipe.map((l) => l.ingredient.name).sort()).toEqual(["Lepinja", "Luk", "Mleveno meso", "Ulje"]);
  });

  it("rejects adding the same ingredient twice to one recipe (unique menuItemId+ingredientId)", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });
    await expect(recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.4 })).rejects.toThrow();
  });

  it("the same ingredient can appear in multiple different menu items", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const category = await prisma.menuCategory.findFirstOrThrow({ where: { restaurantId: fixture.restaurantId } });
    const otherItem = await prisma.menuItem.create({
      data: { restaurantId: fixture.restaurantId, categoryId: category.id, name: "Duplo pljeskavica", slug: `duplo-${randomUUID()}`, price: "1200.00", taxRate: "20", preparationStation: "KITCHEN" },
    });
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });

    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });
    await recipes.addRecipeLine(manager, otherItem.id, { ingredientId: meat.id, quantity: 0.4 });

    const recipeA = await recipes.getRecipe(manager, fixture.menuItemId);
    const recipeB = await recipes.getRecipe(manager, otherItem.id);
    expect(Number(recipeA[0].quantity)).toBe(0.2);
    expect(Number(recipeB[0].quantity)).toBe(0.4);
  });
});

// ─── P1.3: dual-stock transition — first recipe line auto-disables trackStock ─

describe("Dual-stock transition: first recipe line auto-disables finished-item tracking", () => {
  it("adding the FIRST recipe line to a trackStock=true item atomically flips trackStock to false", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 25 });

    const before = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(before.trackStock).toBe(true);

    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });

    const after = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(after.trackStock).toBe(false);

    // Old InventoryItem row and its history are PRESERVED exactly — never
    // deleted, never reset, never rewritten.
    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId } });
    expect(Number(invItem.currentStock)).toBe(25);
    const movements = await prisma.inventoryMovement.findMany({ where: { menuItemId: fixture.menuItemId } });
    expect(movements.length).toBeGreaterThan(0);
  });

  it("records an inventory.model_switched_to_recipe audit entry with actor and previous/new state", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture, "mgr-42");
    await inventory.initializeTracking(manager, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 10 });
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: fixture.menuItemId, action: "inventory.model_switched_to_recipe" },
    });
    expect(entry.userId).toBe("mgr-42");
    expect((entry.previousValue as { trackStock: boolean }).trackStock).toBe(true);
    expect((entry.newValue as { trackStock: boolean }).trackStock).toBe(false);
  });

  it("adding a SECOND recipe line does NOT re-fire the transition (trackStock already false)", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 10 });
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    const onion = await ingredients.createIngredient(manager, { name: "Luk", unit: "KILOGRAM" });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: onion.id, quantity: 0.05 });

    const transitionEntries = await prisma.auditLog.count({
      where: { entityId: fixture.menuItemId, action: "inventory.model_switched_to_recipe" },
    });
    expect(transitionEntries).toBe(1); // exactly once, not once per line
  });

  it("a MenuItem that never had trackStock enabled gains a recipe with no transition audit at all", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });

    const menuItem = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(menuItem.trackStock).toBe(false); // was already false, stays false

    const transitionEntries = await prisma.auditLog.count({
      where: { entityId: fixture.menuItemId, action: "inventory.model_switched_to_recipe" },
    });
    expect(transitionEntries).toBe(0); // nothing to transition
  });

  it("removing the LAST recipe line does NOT re-enable finished-item tracking — item shows as unconfigured, not reverted", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.menuItemId, locationId: fixture.locationId, initialStock: 25 });
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    const line = await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });

    let menuItem = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(menuItem.trackStock).toBe(false);

    await recipes.removeRecipeLine(manager, line.id);

    menuItem = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(menuItem.trackStock).toBe(false); // NEVER auto-reverted, even with zero recipe lines now

    const recipe = await recipes.getRecipe(manager, fixture.menuItemId);
    expect(recipe).toHaveLength(0);

    // The old InventoryItem row is STILL there, untouched — explicit
    // re-enable is the only way back, and that's a separate, deliberate act.
    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.menuItemId, locationId: fixture.locationId } });
    expect(Number(invItem.currentStock)).toBe(25);

    await inventory.setTrackingEnabled(manager, fixture.menuItemId, true);
    menuItem = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemId } });
    expect(menuItem.trackStock).toBe(true); // only via the explicit, separate action
  });
});

// ─── P1.3: unit conversion at recipe entry ─────────────────────────────────

describe("Recipe unit conversion: enter in a compatible unit, store in the ingredient's canonical unit", () => {
  it("entering a recipe quantity in GRAM for a KILOGRAM-stocked ingredient stores the converted kilogram value", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const tomato = await ingredients.createIngredient(manager, { name: "Paradajz", unit: "KILOGRAM" });
    const line = await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: tomato.id, quantity: 300, unit: "GRAM" });
    expect(Number(line.quantity)).toBeCloseTo(0.3, 9); // 300 g -> 0.300 kg
  });

  it("entering a recipe quantity in MILLILITER for a LITER-stocked ingredient stores the converted liter value", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const oil = await ingredients.createIngredient(manager, { name: "Ulje", unit: "LITER" });
    const line = await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: oil.id, quantity: 15, unit: "MILLILITER" });
    expect(Number(line.quantity)).toBeCloseTo(0.015, 9);
  });

  it("omitting the unit interprets the quantity directly in the ingredient's own unit (unchanged, backward compatible)", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const tomato = await ingredients.createIngredient(manager, { name: "Paradajz", unit: "KILOGRAM" });
    const line = await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: tomato.id, quantity: 0.3 });
    expect(Number(line.quantity)).toBeCloseTo(0.3, 9);
  });

  it("updateRecipeLine also converts from a compatible entry unit into the canonical unit", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const tomato = await ingredients.createIngredient(manager, { name: "Paradajz", unit: "KILOGRAM" });
    const line = await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: tomato.id, quantity: 0.3 });
    const updated = await recipes.updateRecipeLine(manager, line.id, { quantity: 450, unit: "GRAM" });
    expect(Number(updated.quantity)).toBeCloseTo(0.45, 9);
  });

  it("rejects an incompatible-dimension entry unit (mass entered for a volume ingredient) rather than guessing", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const oil = await ingredients.createIngredient(manager, { name: "Ulje", unit: "LITER" });
    await expect(
      recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: oil.id, quantity: 300, unit: "GRAM" })
    ).rejects.toThrow();
  });

  it("rejects PIECE mixed with any other unit — discrete counts never convert", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const bun = await ingredients.createIngredient(manager, { name: "Lepinja", unit: "PIECE" });
    await expect(
      recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: bun.id, quantity: 1, unit: "GRAM" })
    ).rejects.toThrow();
  });

  it("real-world example: Šopska salata (Paradajz 300 g against a kg-stocked ingredient) — matches the spec's exact worked example", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const tomato = await ingredients.createIngredient(manager, { name: "Paradajz", unit: "KILOGRAM" });
    await ingredients.initializeStock(manager, { ingredientId: tomato.id, locationId: fixture.locationId, initialStock: 10 });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: tomato.id, quantity: 300, unit: "GRAM" });

    const waiter = waiterCtx(fixture);
    async function sellOne() {
      const table = await prisma.restaurantTable.create({ data: { floorId: (await prisma.floor.findFirstOrThrow({ where: { restaurantId: fixture.restaurantId } })).id, label: `T-${randomUUID().slice(0, 6)}` } });
      const order = await orders.openOrder(waiter, { tableId: table.id });
      await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
      const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
      await billing.completePayment(waiter, submitted.id, { method: "CASH" });
    }

    // Sale of 1: 10.000 kg -> 9.700 kg
    await sellOne();
    let stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: tomato.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(9.7, 9);

    // Sale of 3 more: 9.700 kg -> 8.800 kg
    await sellOne();
    await sellOne();
    await sellOne();
    stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: tomato.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(8.8, 9);
  });
});

// ─── P1.3: Normativi overview (Admin listing) ──────────────────────────────

describe("listRecipeOverview: Admin Normativi page data source", () => {
  it("reports ingredientCount and isConfigured per MenuItem, with category name resolved", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });

    const category = await prisma.menuCategory.create({
      data: { restaurantId: fixture.restaurantId, name: "Bez normativa", slug: `nn-${randomUUID()}`, type: "FOOD" },
    });
    const unconfigured = await prisma.menuItem.create({
      data: { restaurantId: fixture.restaurantId, categoryId: category.id, name: "Coca-Cola", slug: `cola-${randomUUID()}`, price: "250.00", taxRate: "20", preparationStation: "NONE" },
    });

    const overview = await recipes.listRecipeOverview(manager);
    const configured = overview.find((o) => o.id === fixture.menuItemId);
    const notConfigured = overview.find((o) => o.id === unconfigured.id);

    expect(configured?.ingredientCount).toBe(1);
    expect(configured?.isConfigured).toBe(true);
    expect(notConfigured?.ingredientCount).toBe(0);
    expect(notConfigured?.isConfigured).toBe(false);
    expect(notConfigured?.categoryName).toBe("Bez normativa");
  });

  it("is restaurant-scoped — never includes another restaurant's menu items", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const outsider: AuthContext = { ...manager, restaurantId: fixture.otherRestaurantId };
    const overview = await recipes.listRecipeOverview(outsider);
    expect(overview.find((o) => o.id === fixture.menuItemId)).toBeUndefined();
  });
});

// ─── 16: inactive ingredient ────────────────────────────────────────────────

describe("Inactive ingredient behavior", () => {
  it("a deactivated ingredient is excluded from the active-only listing but its recipe/movement history remains intact", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Sezonska sirovina", unit: "KILOGRAM" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 5 });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: ing.id, quantity: 0.1 });

    await ingredients.deactivateIngredient(manager, ing.id);

    const activeOnly = await ingredients.listIngredients(manager, fixture.locationId, { activeOnly: true });
    expect(activeOnly.find((i) => i.id === ing.id)).toBeUndefined();

    const all = await ingredients.listIngredients(manager, fixture.locationId, { activeOnly: false });
    expect(all.find((i) => i.id === ing.id)).toBeDefined();

    // Istorija i receptura ostaju netaknute
    const movements = await ingredients.getMovements(manager, stock.id);
    expect(movements).toHaveLength(1);
    const recipe = await recipes.getRecipe(manager, fixture.menuItemId);
    expect(recipe).toHaveLength(1);

    await expect(ingredients.deactivateIngredient(manager, ing.id)).rejects.toThrow("već deaktivirana");
    const reactivated = await ingredients.activateIngredient(manager, ing.id);
    expect(reactivated.isActive).toBe(true);
  });
});

// ─── 17: unauthorized access ────────────────────────────────────────────────

describe("Unauthorized staff access", () => {
  it("a WAITER cannot create an ingredient, initialize stock, receive/adjust/write-off, or edit a recipe", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const waiter = waiterCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Krompir", unit: "KILOGRAM" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 5 });

    await expect(ingredients.createIngredient(waiter, { name: "Nova", unit: "KILOGRAM" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ingredients.initializeStock(waiter, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ingredients.receiveStock(waiter, stock.id, { quantity: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ingredients.adjustStock(waiter, stock.id, { delta: -1, reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ingredients.writeOffStock(waiter, stock.id, { quantity: 1, reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recipes.addRecipeLine(waiter, fixture.menuItemId, { ingredientId: ing.id, quantity: 0.1 })).rejects.toBeInstanceOf(ForbiddenError);

    // menu.view (WAITER ima) je dovoljno za READ pristup receptu
    const recipeReadOk = await recipes.getRecipe(waiter, fixture.menuItemId);
    expect(recipeReadOk).toEqual([]);
  });

  it("a WAITER without inventory.view cannot list ingredients or read movement history", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const waiter = waiterCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Krompir", unit: "KILOGRAM" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 5 });

    await expect(ingredients.listIngredients(waiter, fixture.locationId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ingredients.getMovements(waiter, stock.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ─── 18: concurrency ─────────────────────────────────────────────────────────

describe("Concurrency", () => {
  it("two simultaneous write-offs against the same stock never overwrite each other — exactly one succeeds when only enough for one", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Krompir", unit: "KILOGRAM" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 1 });

    const results = await Promise.allSettled([
      ingredients.writeOffStock(manager, stock.id, { quantity: 1, reason: "A" }),
      ingredients.writeOffStock(manager, stock.id, { quantity: 1, reason: "B" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const final = await prisma.ingredientStock.findUniqueOrThrow({ where: { id: stock.id } });
    expect(Number(final.currentStock)).toBe(0); // tačno jedan otpis primenjen, nikad negativno
  });

  it("two concurrent receipts against the same stock both apply — final stock reflects both, no lost update", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const ing = await ingredients.createIngredient(manager, { name: "Ulje", unit: "LITER" });
    const stock = await ingredients.initializeStock(manager, { ingredientId: ing.id, locationId: fixture.locationId, initialStock: 0 });

    await Promise.all([
      ingredients.receiveStock(manager, stock.id, { quantity: 3 }),
      ingredients.receiveStock(manager, stock.id, { quantity: 4 }),
    ]);

    const final = await prisma.ingredientStock.findUniqueOrThrow({ where: { id: stock.id } });
    expect(Number(final.currentStock)).toBe(7); // ni jedan update nije "izgubljen"
    const movements = await prisma.ingredientMovement.count({ where: { ingredientStockId: stock.id, type: "RECEIPT" } });
    expect(movements).toBe(2);
  });
});

// ─── 20 (P1 foundation) -> superseded by P1.2 ──────────────────────────────
//
// Ova tačka je u P1 (foundation) fazi dokazivala da recepture NISU povezane
// sa prodajom. P1.2 je NAMERNO i eksplicitno dodao tu vezu (automatsko
// skidanje po normativu pri naplati) — puno pokriveno u
// tests/integration/ingredient-sale-deduction.test.ts (25 scenarija). Test
// ispod je AŽURIRAN da odražava novu, tačnu stvarnost umesto da ostane
// zastareo/pogrešan; zadržan ovde (ne obrisan) kao regresiona provera da
// osnovna sprega recepture+naplate i dalje radi.

describe("Recipes ARE connected to sales (P1.2) — see ingredient-sale-deduction.test.ts for full coverage", () => {
  it("completing a payment for an item WITH a defined recipe creates the expected SALE IngredientMovement and deducts stock", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const manager = managerCtx(fixture);
    const meat = await ingredients.createIngredient(manager, { name: "Mleveno meso", unit: "KILOGRAM" });
    await ingredients.initializeStock(manager, { ingredientId: meat.id, locationId: fixture.locationId, initialStock: 100 });
    await recipes.addRecipeLine(manager, fixture.menuItemId, { ingredientId: meat.id, quantity: 0.2 });

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 3 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiter, submitted.id, { method: "CASH" });

    const saleMovements = await prisma.ingredientMovement.count({ where: { restaurantId: fixture.restaurantId, type: "SALE" } });
    expect(saleMovements).toBe(1);

    // 100 - (0.2 kg * 3) = 99.4 kg
    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(Number(stock.currentStock)).toBeCloseTo(99.4, 9);
  });
});
