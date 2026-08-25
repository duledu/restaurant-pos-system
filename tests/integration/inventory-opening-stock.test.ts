/**
 * Integracioni testovi za GO-LIVE masovnu inicijalizaciju/reset zaliha
 * (inventory.bulkSetOpeningStock / bulkZeroOpeningStock).
 *
 * Namerno NE duplira postojece pokrivanje iz tests/integration/inventory.test.ts
 * (osnovna inicijalizacija, RECEIPT/ADJUSTMENT/WRITE_OFF, SALE odbitak,
 * idempotentnost po paymentId, sabiranje vise redova istog artikla,
 * konkurentnost, tenant izolacija za scopeToRestaurant obrazac) -- ovde se
 * testira SAMO ono sto je novo: masovna operacija, njena stroza dozvola
 * (inventory.opening_stock, namerno bez MANAGER-a za razliku od
 * inventory.manage), atomicnost i cuvanje istorije kretanja.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { inventory, ingredients, recipes } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  locationBId: string;
  menuItemAId: string;
  menuItemBId: string;
}

function ctxFor(fixture: Fixture, role: string, employeeId: string, extraPermissions: string[] = []): AuthContext {
  const base = ["menu.view"];
  const byRole: Record<string, string[]> = {
    OWNER: ["inventory.view", "inventory.manage", "inventory.opening_stock"],
    ADMIN: ["inventory.view", "inventory.manage", "inventory.opening_stock"],
    MANAGER: ["inventory.view", "inventory.manage"], // deliberately NO inventory.opening_stock
    WAITER: [],
    KITCHEN: [],
    BAR: [],
  };
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId, fixture.locationBId],
    roles: [role],
    permissions: new Set([...base, ...(byRole[role] ?? []), ...extraPermissions]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "OpeningStock tenant", slug: `os-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "OpeningStock Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const locationB = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Branch" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Cat", slug: `cat-${randomUUID()}`, type: "FOOD" },
  });
  const menuItemA = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Item A", slug: `a-${randomUUID()}`, price: "300", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const menuItemB = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Item B", slug: `b-${randomUUID()}`, price: "400", taxRate: "20", preparationStation: "BAR" },
  });
  return { restaurantId: restaurant.id, locationId: location.id, locationBId: locationB.id, menuItemAId: menuItemA.id, menuItemBId: menuItemB.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("inventory opening-stock: authorization", () => {
  it("OWNER can bulk-set opening stock", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");
    const result = await inventory.bulkSetOpeningStock(owner, {
      locationId: fixture.locationId,
      lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }],
    });
    expect(result.itemsAffected).toBe(1);
    expect(result.results[0].after).toBe(30);
  });

  it("ADMIN can bulk-set opening stock", async () => {
    const fixture = await createFixture();
    const admin = ctxFor(fixture, "ADMIN", "admin-1");
    const result = await inventory.bulkSetOpeningStock(admin, {
      locationId: fixture.locationId,
      lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }],
    });
    expect(result.itemsAffected).toBe(1);
  });

  it("MANAGER cannot bulk-set opening stock even though MANAGER already has inventory.manage", async () => {
    const fixture = await createFixture();
    const manager = ctxFor(fixture, "MANAGER", "mgr-1");
    await expect(
      inventory.bulkSetOpeningStock(manager, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] })
    ).rejects.toThrow();
  });

  it("WAITER cannot bulk-set opening stock", async () => {
    const fixture = await createFixture();
    const waiter = ctxFor(fixture, "WAITER", "w-1");
    await expect(
      inventory.bulkSetOpeningStock(waiter, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] })
    ).rejects.toThrow();
  });

  it("KITCHEN cannot bulk-set opening stock", async () => {
    const fixture = await createFixture();
    const kitchen = ctxFor(fixture, "KITCHEN", "k-1");
    await expect(
      inventory.bulkSetOpeningStock(kitchen, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] })
    ).rejects.toThrow();
  });

  it("BAR cannot bulk-set opening stock", async () => {
    const fixture = await createFixture();
    const bar = ctxFor(fixture, "BAR", "b-1");
    await expect(
      inventory.bulkSetOpeningStock(bar, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] })
    ).rejects.toThrow();
  });

  it("MANAGER cannot call the zero-all reset either", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");
    await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] });

    const manager = ctxFor(fixture, "MANAGER", "mgr-1");
    await expect(inventory.bulkZeroOpeningStock(manager, { locationId: fixture.locationId })).rejects.toThrow();
  });
});

describe("inventory opening-stock: scoping", () => {
  it("cannot modify another restaurant's items via bulkSetOpeningStock", async () => {
    const fixtureA = await createFixture();
    const fixtureB = await createFixture();
    const ownerA = ctxFor(fixtureA, "OWNER", "owner-a");

    await expect(
      inventory.bulkSetOpeningStock(ownerA, {
        locationId: fixtureA.locationId,
        lines: [{ menuItemId: fixtureB.menuItemAId, quantity: 30 }], // belongs to restaurant B
      })
    ).rejects.toThrow();

    const leaked = await prisma.inventoryItem.findFirst({ where: { menuItemId: fixtureB.menuItemAId } });
    expect(leaked).toBeNull();
  });

  it("cannot target another restaurant's location", async () => {
    const fixtureA = await createFixture();
    const fixtureB = await createFixture();
    const ownerA = ctxFor(fixtureA, "OWNER", "owner-a");

    await expect(
      inventory.bulkSetOpeningStock(ownerA, {
        locationId: fixtureB.locationId, // belongs to restaurant B
        lines: [{ menuItemId: fixtureA.menuItemAId, quantity: 30 }],
      })
    ).rejects.toThrow();
  });

  it("setting opening stock at Location A never touches the same menu item's stock at Location B", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] });
    await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationBId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 5 }] });

    const atA = await prisma.inventoryItem.findUnique({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemAId } } });
    const atB = await prisma.inventoryItem.findUnique({ where: { locationId_menuItemId: { locationId: fixture.locationBId, menuItemId: fixture.menuItemAId } } });
    expect(Number(atA?.currentStock)).toBe(30);
    expect(Number(atB?.currentStock)).toBe(5);
  });
});

describe("inventory opening-stock: atomicity", () => {
  it("if one line references a foreign menu item, the entire batch is rejected and NOTHING is applied", async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    await expect(
      inventory.bulkSetOpeningStock(owner, {
        locationId: fixture.locationId,
        lines: [
          { menuItemId: fixture.menuItemAId, quantity: 30 },
          { menuItemId: foreign.menuItemAId, quantity: 30 }, // invalid — belongs to a different restaurant
        ],
      })
    ).rejects.toThrow();

    // menuItemA must NOT have been initialized despite being first/valid in the batch
    const item = await prisma.inventoryItem.findUnique({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemAId } } });
    expect(item).toBeNull();
  });

  it("a fully valid multi-item batch applies every line together", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    const result = await inventory.bulkSetOpeningStock(owner, {
      locationId: fixture.locationId,
      lines: [
        { menuItemId: fixture.menuItemAId, quantity: 30 },
        { menuItemId: fixture.menuItemBId, quantity: 15 },
      ],
    });
    expect(result.itemsAffected).toBe(2);

    const a = await prisma.inventoryItem.findUnique({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemAId } } });
    const b = await prisma.inventoryItem.findUnique({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemBId } } });
    expect(Number(a?.currentStock)).toBe(30);
    expect(Number(b?.currentStock)).toBe(15);
  });
});

// ─── P1.3: recipe-governed items are excluded/rejected, never silently reinitialized ─

describe("inventory opening-stock: recipe-governed items are protected", () => {
  it("bulkSetOpeningStock REJECTS the whole batch if any line targets a recipe-governed item", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");
    const meat = await ingredients.createIngredient(owner, { name: "Meso", unit: "KILOGRAM" });
    await recipes.addRecipeLine(owner, fixture.menuItemAId, { ingredientId: meat.id, quantity: 0.2 });

    await expect(
      inventory.bulkSetOpeningStock(owner, {
        locationId: fixture.locationId,
        lines: [
          { menuItemId: fixture.menuItemAId, quantity: 30 }, // recipe-governed — must reject the WHOLE batch
          { menuItemId: fixture.menuItemBId, quantity: 15 },
        ],
      })
    ).rejects.toThrow(/normativ/i);

    // Item B (valid, direct-stock) must NOT have been applied either — whole-batch rejection
    const b = await prisma.inventoryItem.findUnique({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemBId } } });
    expect(b).toBeNull();
    // Item A's trackStock must NOT have been force-enabled by the rejected attempt
    const menuItemA = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.menuItemAId } });
    expect(menuItemA.trackStock).toBe(false);
  });

  it("bulkZeroOpeningStock SKIPS a recipe-governed item's frozen historical stock — never zeroes or rewrites it", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    // Item A: direct-stock, initialized normally.
    await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] });

    // Item B: WAS finished-stock (frozen at 15), THEN got a recipe (legacy/
    // pre-existing InventoryItem row, now recipe-governed going forward).
    await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemBId, quantity: 15 }] });
    const meat = await ingredients.createIngredient(owner, { name: "Meso", unit: "KILOGRAM" });
    await recipes.addRecipeLine(owner, fixture.menuItemBId, { ingredientId: meat.id, quantity: 0.2 });
    const bBeforeReset = await prisma.inventoryItem.findUniqueOrThrow({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemBId } } });
    const bMovementsBeforeReset = await prisma.inventoryMovement.count({ where: { menuItemId: fixture.menuItemBId } });

    const result = await inventory.bulkZeroOpeningStock(owner, { locationId: fixture.locationId });

    // Item A (direct-stock) was reset to 0, as expected.
    expect(result.results.find((r) => r.menuItemId === fixture.menuItemAId)?.after).toBe(0);
    // Item B (recipe-governed) is ABSENT from the results entirely — never touched.
    expect(result.results.find((r) => r.menuItemId === fixture.menuItemBId)).toBeUndefined();

    const bAfterReset = await prisma.inventoryItem.findUniqueOrThrow({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemBId } } });
    expect(Number(bAfterReset.currentStock)).toBe(Number(bBeforeReset.currentStock)); // unchanged (still 15)
    const bMovementsAfterReset = await prisma.inventoryMovement.count({ where: { menuItemId: fixture.menuItemBId } });
    expect(bMovementsAfterReset).toBe(bMovementsBeforeReset); // no new movement created for it

    // Its full history is still readable (viewable via the existing
    // getMovements/"Historija" path — nothing about the reset hides it).
    const movements = await inventory.getMovements(owner, bAfterReset.id);
    expect(movements.length).toBeGreaterThan(0);
  });

  it("bulkZeroOpeningStock with EVERY tracked item recipe-governed is a safe no-op, not an error", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");
    await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] });
    const meat = await ingredients.createIngredient(owner, { name: "Meso", unit: "KILOGRAM" });
    await recipes.addRecipeLine(owner, fixture.menuItemAId, { ingredientId: meat.id, quantity: 0.2 });

    const result = await inventory.bulkZeroOpeningStock(owner, { locationId: fixture.locationId });
    expect(result.itemsAffected).toBe(0);
    expect(result.results).toHaveLength(0);

    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemAId } } });
    expect(Number(item.currentStock)).toBe(30); // untouched
  });
});

describe("inventory opening-stock: reconciliation semantics and history preservation", () => {
  it("reconciling from a non-zero stock to a new quantity records the true delta, before, and after", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 27 }] });
    const result = await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 42 }] });

    expect(result.results[0]).toMatchObject({ before: 27, after: 42 });

    const invItem = await prisma.inventoryItem.findUnique({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemAId } } });
    const movement = await prisma.inventoryMovement.findFirst({
      where: { inventoryItemId: invItem!.id, type: "OPENING_STOCK" },
      orderBy: { createdAt: "desc" },
    });
    expect(movement).not.toBeNull();
    expect(Number(movement!.quantityDelta)).toBe(15);
    expect(Number(movement!.quantityBefore)).toBe(27);
    expect(Number(movement!.quantityAfter)).toBe(42);
  });

  it("re-applying the SAME target quantity is a no-op — no duplicate movement is created", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] });
    const second = await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] });

    expect(second.itemsAffected).toBe(0);
    expect(second.itemsUnchanged).toBe(1);

    const invItem = await prisma.inventoryItem.findUnique({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemAId } } });
    const movementCount = await prisma.inventoryMovement.count({ where: { inventoryItemId: invItem!.id } });
    expect(movementCount).toBe(1); // only the first call's movement — the second created none
  });

  it("bulkZeroOpeningStock reconciles every tracked item to 0 via an auditable movement, never a delete", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");
    await inventory.bulkSetOpeningStock(owner, {
      locationId: fixture.locationId,
      lines: [
        { menuItemId: fixture.menuItemAId, quantity: 30 },
        { menuItemId: fixture.menuItemBId, quantity: 15 },
      ],
    });

    const result = await inventory.bulkZeroOpeningStock(owner, { locationId: fixture.locationId });
    expect(result.itemsAffected).toBe(2);
    expect(result.results.every((r) => r.after === 0)).toBe(true);

    // InventoryItem rows still exist (not deleted) and every movement is preserved.
    const items = await prisma.inventoryItem.findMany({ where: { restaurantId: fixture.restaurantId, locationId: fixture.locationId } });
    expect(items).toHaveLength(2);
    expect(items.every((i) => Number(i.currentStock) === 0)).toBe(true);

    for (const item of items) {
      const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item.id } });
      expect(movements.length).toBeGreaterThanOrEqual(2); // OPENING_STOCK (set) + OPENING_STOCK (zero)
    }
  });

  it("bulkZeroOpeningStock with nothing tracked yet is a safe no-op", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");
    const result = await inventory.bulkZeroOpeningStock(owner, { locationId: fixture.locationId });
    expect(result.itemsAffected).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it("bulkSetOpeningStock can initialize a brand-new (never-tracked) item directly, not just reconcile existing ones", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    const before = await prisma.inventoryItem.findUnique({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemAId } } });
    expect(before).toBeNull();

    const result = await inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: 30 }] });
    expect(result.results[0]).toMatchObject({ before: 0, after: 30 });

    const menuItem = await prisma.menuItem.findUnique({ where: { id: fixture.menuItemAId } });
    expect(menuItem?.trackStock).toBe(true);
  });

  it("rejects a negative target quantity without creating anything", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");
    await expect(
      inventory.bulkSetOpeningStock(owner, { locationId: fixture.locationId, lines: [{ menuItemId: fixture.menuItemAId, quantity: -1 }] })
    ).rejects.toThrow();
    const item = await prisma.inventoryItem.findUnique({ where: { locationId_menuItemId: { locationId: fixture.locationId, menuItemId: fixture.menuItemAId } } });
    expect(item).toBeNull();
  });
});
