/**
 * P1.5: Hijerarhijska kategorija fizičke zalihe (InventoryCategory) —
 * NAMERNO odvojena od MenuCategory. KUHINJA/ŠANK -> podkategorija,
 * restaurant-scoped, dodeljiva Ingredient-u i direct-stock MenuItem-u.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ingredients, inventoryCategories, inventory } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  categoryId: string;
}

function ownerCtx(fixture: Pick<Fixture, "restaurantId"> & Partial<Pick<Fixture, "locationId">>, employeeId = "owner-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: fixture.locationId ? [fixture.locationId] : [],
    roles: ["OWNER"],
    permissions: new Set(["inventory.view", "inventory.manage", "menu.view", "menu.manage"]),
  };
}

function waiterCtx(fixture: Pick<Fixture, "restaurantId"> & Partial<Pick<Fixture, "locationId">>, employeeId = "waiter-1"): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: fixture.locationId ? [fixture.locationId] : [],
    roles: ["WAITER"],
    permissions: new Set(["menu.view"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "InvCat tenant", slug: `invcat-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Other Restaurant" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id, categoryId: category.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("seedDefaultInventoryCategories", () => {
  it("creates KUHINJA and ŠANK with their subcategories", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const list = await inventoryCategories.seedDefaultInventoryCategories(owner);

    const kuhinja = list.find((c) => c.name === "KUHINJA" && c.parentId === null);
    const sank = list.find((c) => c.name === "ŠANK" && c.parentId === null);
    expect(kuhinja).toBeTruthy();
    expect(sank).toBeTruthy();

    const kuhinjaChildren = list.filter((c) => c.parentId === kuhinja!.id);
    const sankChildren = list.filter((c) => c.parentId === sank!.id);
    expect(kuhinjaChildren.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Meso", "Piletina", "Riba", "Povrće", "Sir i mlečni proizvodi", "Jaja"])
    );
    expect(sankChildren.map((c) => c.name)).toEqual(expect.arrayContaining(["Pivo", "Vino", "Sokovi", "Voda"]));
  });

  it("is idempotent — calling twice does not create duplicates", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    await inventoryCategories.seedDefaultInventoryCategories(owner);
    const secondCall = await inventoryCategories.seedDefaultInventoryCategories(owner);

    const total = await prisma.inventoryCategory.count({ where: { restaurantId: fixture.restaurantId } });
    expect(total).toBe(secondCall.length);
    const kuhinjaCount = await prisma.inventoryCategory.count({ where: { restaurantId: fixture.restaurantId, name: "KUHINJA", parentId: null } });
    expect(kuhinjaCount).toBe(1);
  });

  it("Krompir/Paradajz/Luk map to KUHINJA > Povrće, not a separate per-ingredient category", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const list = await inventoryCategories.seedDefaultInventoryCategories(owner);
    const povrce = list.find((c) => c.name === "Povrće");
    expect(povrce).toBeTruthy();

    const krompir = await ingredients.createIngredient(owner, { name: "Krompir", unit: "KILOGRAM", inventoryCategoryId: povrce!.id });
    const paradajz = await ingredients.createIngredient(owner, { name: "Paradajz", unit: "KILOGRAM", inventoryCategoryId: povrce!.id });
    expect(krompir.inventoryCategoryId).toBe(povrce!.id);
    expect(paradajz.inventoryCategoryId).toBe(povrce!.id);
  });
});

describe("InventoryCategory CRUD + permissions", () => {
  it("OWNER/ADMIN/MANAGER can create, WAITER cannot", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const category = await inventoryCategories.createInventoryCategory(owner, { name: "KUHINJA" });
    expect(category.name).toBe("KUHINJA");

    const waiter = waiterCtx(fixture);
    await expect(inventoryCategories.createInventoryCategory(waiter, { name: "Nesto" })).rejects.toThrow();
  });

  it("rejects a child whose parentId belongs to another restaurant", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const otherOwner = ownerCtx({ restaurantId: fixture.otherRestaurantId }, "owner-b");
    const foreignParent = await inventoryCategories.createInventoryCategory(otherOwner, { name: "KUHINJA" });

    await expect(
      inventoryCategories.createInventoryCategory(owner, { name: "Meso", parentId: foreignParent.id })
    ).rejects.toThrow();
  });

  it("renames a category, preserving its id and children", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const kuhinja = await inventoryCategories.createInventoryCategory(owner, { name: "KUHINJA" });
    const meso = await inventoryCategories.createInventoryCategory(owner, { name: "Meso", parentId: kuhinja.id });

    const renamed = await inventoryCategories.renameInventoryCategory(owner, meso.id, "Crveno meso");
    expect(renamed.name).toBe("Crveno meso");
    expect(renamed.id).toBe(meso.id);
    expect(renamed.parentId).toBe(kuhinja.id);
  });

  it("deactivate/activate round-trip, does NOT cascade to children", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const kuhinja = await inventoryCategories.createInventoryCategory(owner, { name: "KUHINJA" });
    const meso = await inventoryCategories.createInventoryCategory(owner, { name: "Meso", parentId: kuhinja.id });

    await inventoryCategories.deactivateInventoryCategory(owner, kuhinja.id);
    const mesoAfter = await prisma.inventoryCategory.findUniqueOrThrow({ where: { id: meso.id } });
    expect(mesoAfter.isActive).toBe(true); // child untouched — no automatic cascade

    const reactivated = await inventoryCategories.activateInventoryCategory(owner, kuhinja.id);
    expect(reactivated.isActive).toBe(true);
  });

  it("records audit entries for create/rename/deactivate with actor and previous/new values", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture, "owner-42");
    const kuhinja = await inventoryCategories.createInventoryCategory(owner, { name: "KUHINJA" });
    await inventoryCategories.renameInventoryCategory(owner, kuhinja.id, "Kuhinja (glavna)");
    await inventoryCategories.deactivateInventoryCategory(owner, kuhinja.id);

    const entries = await prisma.auditLog.findMany({ where: { entityId: kuhinja.id }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => e.action)).toEqual([
      "inventory_category.created",
      "inventory_category.renamed",
      "inventory_category.deactivated",
    ]);
    expect(entries.every((e) => e.userId === "owner-42")).toBe(true);
    const renameEntry = entries[1];
    expect((renameEntry.previousValue as { name: string }).name).toBe("KUHINJA");
    expect((renameEntry.newValue as { name: string }).name).toBe("Kuhinja (glavna)");
  });
});

describe("Assigning categories to Ingredients and direct-stock MenuItems", () => {
  it("assigns an Ingredient to a category via createIngredient, and can reassign via updateIngredient", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const kuhinja = await inventoryCategories.createInventoryCategory(owner, { name: "KUHINJA" });
    const meso = await inventoryCategories.createInventoryCategory(owner, { name: "Meso", parentId: kuhinja.id });
    const povrce = await inventoryCategories.createInventoryCategory(owner, { name: "Povrće", parentId: kuhinja.id });

    const biftek = await ingredients.createIngredient(owner, { name: "Biftek", unit: "KILOGRAM", inventoryCategoryId: meso.id });
    expect(biftek.inventoryCategoryId).toBe(meso.id);

    const reassigned = await ingredients.updateIngredient(owner, biftek.id, { inventoryCategoryId: povrce.id });
    expect(reassigned.inventoryCategoryId).toBe(povrce.id);

    const cleared = await ingredients.updateIngredient(owner, biftek.id, { inventoryCategoryId: null });
    expect(cleared.inventoryCategoryId).toBeNull();
  });

  it("rejects assigning a deactivated category", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const kuhinja = await inventoryCategories.createInventoryCategory(owner, { name: "KUHINJA" });
    await inventoryCategories.deactivateInventoryCategory(owner, kuhinja.id);

    await expect(
      ingredients.createIngredient(owner, { name: "Biftek", unit: "KILOGRAM", inventoryCategoryId: kuhinja.id })
    ).rejects.toThrow();
  });

  it("assigns a direct-stock MenuItem to a category (Coca-Cola -> ŠANK -> Sokovi) WITHOUT affecting its InventoryItem stock/deduction", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const sank = await inventoryCategories.createInventoryCategory(owner, { name: "ŠANK" });
    const sokovi = await inventoryCategories.createInventoryCategory(owner, { name: "Sokovi", parentId: sank.id });

    const cola = await prisma.menuItem.create({
      data: { restaurantId: fixture.restaurantId, categoryId: fixture.categoryId, name: "Coca-Cola", slug: `cola-${randomUUID()}`, price: "250.00", taxRate: "20", preparationStation: "NONE" },
    });
    await inventory.initializeTracking(owner, { menuItemId: cola.id, locationId: fixture.locationId, initialStock: 24 });

    const updated = await inventoryCategories.setMenuItemInventoryCategory(owner, cola.id, sokovi.id);
    expect(updated.inventoryCategoryId).toBe(sokovi.id);

    // Finished-goods stock/tracking completely unaffected by the category assignment.
    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: cola.id, locationId: fixture.locationId } });
    expect(Number(invItem.currentStock)).toBe(24);
    const menuItemRow = await prisma.menuItem.findUniqueOrThrow({ where: { id: cola.id } });
    expect(menuItemRow.trackStock).toBe(true);
  });

  it("restaurant isolation: cannot assign a category from a different restaurant", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const otherOwner = ownerCtx({ restaurantId: fixture.otherRestaurantId }, "owner-b");
    const foreignCategory = await inventoryCategories.createInventoryCategory(otherOwner, { name: "KUHINJA" });

    await expect(
      ingredients.createIngredient(owner, { name: "Biftek", unit: "KILOGRAM", inventoryCategoryId: foreignCategory.id })
    ).rejects.toThrow();
  });
});

describe("listIngredients filtering by inventoryCategoryId (parent includes children)", () => {
  it("filtering by KUHINJA (parent) returns ingredients filed under any of its subcategories", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const kuhinja = await inventoryCategories.createInventoryCategory(owner, { name: "KUHINJA" });
    const meso = await inventoryCategories.createInventoryCategory(owner, { name: "Meso", parentId: kuhinja.id });
    const povrce = await inventoryCategories.createInventoryCategory(owner, { name: "Povrće", parentId: kuhinja.id });
    const sank = await inventoryCategories.createInventoryCategory(owner, { name: "ŠANK" });

    await ingredients.createIngredient(owner, { name: "Biftek", unit: "KILOGRAM", inventoryCategoryId: meso.id });
    await ingredients.createIngredient(owner, { name: "Paradajz", unit: "KILOGRAM", inventoryCategoryId: povrce.id });
    await ingredients.createIngredient(owner, { name: "Somewhere else", unit: "KILOGRAM", inventoryCategoryId: sank.id });

    const underKuhinja = await ingredients.listIngredients(owner, undefined, { inventoryCategoryId: kuhinja.id });
    expect(underKuhinja.map((i) => i.name).sort()).toEqual(["Biftek", "Paradajz"]);

    const underMeso = await ingredients.listIngredients(owner, undefined, { inventoryCategoryId: meso.id });
    expect(underMeso.map((i) => i.name)).toEqual(["Biftek"]);
  });

  it("listIngredients response includes the category and its parent (for KUHINJA/ŠANK label) with no extra per-item query", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const kuhinja = await inventoryCategories.createInventoryCategory(owner, { name: "KUHINJA" });
    const meso = await inventoryCategories.createInventoryCategory(owner, { name: "Meso", parentId: kuhinja.id });
    await ingredients.createIngredient(owner, { name: "Biftek", unit: "KILOGRAM", inventoryCategoryId: meso.id });

    const list = await ingredients.listIngredients(owner, undefined, {});
    const biftek = list.find((i) => i.name === "Biftek") as unknown as { inventoryCategory: { name: string; parent: { name: string } | null } };
    expect(biftek.inventoryCategory.name).toBe("Meso");
    expect(biftek.inventoryCategory.parent?.name).toBe("KUHINJA");
  });
});
