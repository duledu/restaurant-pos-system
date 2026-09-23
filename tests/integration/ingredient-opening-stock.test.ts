/**
 * Integration tests for the Inventory Phase 2 ingredient-side bulk
 * opening-stock action (ingredients.bulkSetIngredientOpeningStock) — the
 * raw-ingredient counterpart to inventory.bulkSetOpeningStock, covered by
 * tests/integration/inventory-opening-stock.test.ts. Mirrors that file's
 * authorization/scoping/atomicity/reconciliation coverage rather than
 * duplicating every case; adds a decimal-quantity test since ingredients
 * (kg/l/ml) are fractional, unlike the integer-only finished-goods route.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ingredients } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  locationBId: string;
  ingredientAId: string;
  ingredientBId: string;
}

function ctxFor(fixture: Fixture, role: string, employeeId: string): AuthContext {
  const byRole: Record<string, string[]> = {
    OWNER: ["inventory.view", "inventory.manage", "inventory.opening_stock"],
    ADMIN: ["inventory.view", "inventory.manage", "inventory.opening_stock"],
    MANAGER: ["inventory.view", "inventory.manage"], // deliberately NO inventory.opening_stock
    WAITER: [],
  };
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId, fixture.locationBId],
    roles: [role],
    permissions: new Set(byRole[role] ?? []),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "IngOpeningStock tenant", slug: `ios-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "IngOpeningStock Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const locationB = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Branch" } });
  const ownerCtxSeed: AuthContext = {
    userId: "seed", employeeId: "seed", restaurantId: restaurant.id, locationIds: [location.id, locationB.id],
    roles: ["OWNER"], permissions: new Set(["inventory.manage"]),
  };
  const ingredientA = await ingredients.createIngredient(ownerCtxSeed, { name: "Juneće meso", unit: "KILOGRAM" });
  const ingredientB = await ingredients.createIngredient(ownerCtxSeed, { name: "Pivo", unit: "PIECE" });
  return { restaurantId: restaurant.id, locationId: location.id, locationBId: locationB.id, ingredientAId: ingredientA.id, ingredientBId: ingredientB.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("ingredient opening-stock: authorization", () => {
  it("OWNER can bulk-set ingredient opening stock", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");
    const result = await ingredients.bulkSetIngredientOpeningStock(owner, {
      locationId: fixture.locationId,
      lines: [{ ingredientId: fixture.ingredientAId, quantity: 12.4 }],
    });
    expect(result.itemsAffected).toBe(1);
    expect(result.results[0].after).toBe(12.4);
  });

  it("MANAGER cannot bulk-set ingredient opening stock even though MANAGER already has inventory.manage", async () => {
    const fixture = await createFixture();
    const manager = ctxFor(fixture, "MANAGER", "mgr-1");
    await expect(
      ingredients.bulkSetIngredientOpeningStock(manager, { locationId: fixture.locationId, lines: [{ ingredientId: fixture.ingredientAId, quantity: 10 }] })
    ).rejects.toThrow();
  });

  it("WAITER cannot bulk-set ingredient opening stock", async () => {
    const fixture = await createFixture();
    const waiter = ctxFor(fixture, "WAITER", "w-1");
    await expect(
      ingredients.bulkSetIngredientOpeningStock(waiter, { locationId: fixture.locationId, lines: [{ ingredientId: fixture.ingredientAId, quantity: 10 }] })
    ).rejects.toThrow();
  });
});

describe("ingredient opening-stock: scoping and atomicity", () => {
  it("cannot modify another restaurant's ingredients via bulk opening stock", async () => {
    const fixtureA = await createFixture();
    const fixtureB = await createFixture();
    const ownerA = ctxFor(fixtureA, "OWNER", "owner-a");

    await expect(
      ingredients.bulkSetIngredientOpeningStock(ownerA, {
        locationId: fixtureA.locationId,
        lines: [{ ingredientId: fixtureB.ingredientAId, quantity: 10 }], // belongs to restaurant B
      })
    ).rejects.toThrow();

    const leaked = await prisma.ingredientStock.findFirst({ where: { ingredientId: fixtureB.ingredientAId, locationId: fixtureA.locationId } });
    expect(leaked).toBeNull();
  });

  it("if one line references a foreign ingredient, the entire batch is rejected and NOTHING is applied", async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    await expect(
      ingredients.bulkSetIngredientOpeningStock(owner, {
        locationId: fixture.locationId,
        lines: [
          { ingredientId: fixture.ingredientAId, quantity: 10 },
          { ingredientId: foreign.ingredientAId, quantity: 5 }, // invalid — belongs to a different restaurant
        ],
      })
    ).rejects.toThrow();

    const stock = await prisma.ingredientStock.findFirst({ where: { ingredientId: fixture.ingredientAId, locationId: fixture.locationId } });
    expect(stock).toBeNull(); // whole batch rejected, valid line also not applied
  });

  it("a fully valid multi-ingredient batch with fractional (kg/pcs) quantities applies every line together", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    const result = await ingredients.bulkSetIngredientOpeningStock(owner, {
      locationId: fixture.locationId,
      lines: [
        { ingredientId: fixture.ingredientAId, quantity: 12.4 }, // kg
        { ingredientId: fixture.ingredientBId, quantity: 52 },   // pcs
      ],
    });
    expect(result.itemsAffected).toBe(2);

    const a = await prisma.ingredientStock.findFirst({ where: { ingredientId: fixture.ingredientAId, locationId: fixture.locationId } });
    const b = await prisma.ingredientStock.findFirst({ where: { ingredientId: fixture.ingredientBId, locationId: fixture.locationId } });
    expect(Number(a?.currentStock)).toBeCloseTo(12.4, 9);
    expect(Number(b?.currentStock)).toBe(52);
  });
});

describe("ingredient opening-stock: reconciliation semantics and history preservation", () => {
  it("reconciling from a non-zero stock to a new quantity records the true delta, before, and after via an OPENING_STOCK movement", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    await ingredients.bulkSetIngredientOpeningStock(owner, { locationId: fixture.locationId, lines: [{ ingredientId: fixture.ingredientAId, quantity: 10 }] });
    const result = await ingredients.bulkSetIngredientOpeningStock(owner, { locationId: fixture.locationId, lines: [{ ingredientId: fixture.ingredientAId, quantity: 12.4 }] });

    expect(result.results[0]).toMatchObject({ before: 10, after: 12.4 });

    const stock = await prisma.ingredientStock.findFirst({ where: { ingredientId: fixture.ingredientAId, locationId: fixture.locationId } });
    const movement = await prisma.ingredientMovement.findFirst({
      where: { ingredientStockId: stock!.id, type: "OPENING_STOCK" },
      orderBy: { createdAt: "desc" },
    });
    expect(movement).not.toBeNull();
    expect(Number(movement!.quantityBefore)).toBe(10);
    expect(Number(movement!.quantityAfter)).toBeCloseTo(12.4, 9);
  });

  it("re-applying the SAME target quantity is a no-op — no duplicate movement is created", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    await ingredients.bulkSetIngredientOpeningStock(owner, { locationId: fixture.locationId, lines: [{ ingredientId: fixture.ingredientAId, quantity: 10 }] });
    const second = await ingredients.bulkSetIngredientOpeningStock(owner, { locationId: fixture.locationId, lines: [{ ingredientId: fixture.ingredientAId, quantity: 10 }] });

    expect(second.itemsAffected).toBe(0);
    expect(second.itemsUnchanged).toBe(1);

    const stock = await prisma.ingredientStock.findFirst({ where: { ingredientId: fixture.ingredientAId, locationId: fixture.locationId } });
    const movementCount = await prisma.ingredientMovement.count({ where: { ingredientStockId: stock!.id } });
    expect(movementCount).toBe(1); // only the first call's movement
  });

  it("setting opening stock at Location A never touches the same ingredient's stock at Location B", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    await ingredients.bulkSetIngredientOpeningStock(owner, { locationId: fixture.locationId, lines: [{ ingredientId: fixture.ingredientAId, quantity: 30 }] });
    await ingredients.bulkSetIngredientOpeningStock(owner, { locationId: fixture.locationBId, lines: [{ ingredientId: fixture.ingredientAId, quantity: 5 }] });

    const atA = await prisma.ingredientStock.findFirst({ where: { ingredientId: fixture.ingredientAId, locationId: fixture.locationId } });
    const atB = await prisma.ingredientStock.findFirst({ where: { ingredientId: fixture.ingredientAId, locationId: fixture.locationBId } });
    expect(Number(atA?.currentStock)).toBe(30);
    expect(Number(atB?.currentStock)).toBe(5);
  });

  it("rejects a negative target quantity without creating anything", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");
    await expect(
      ingredients.bulkSetIngredientOpeningStock(owner, { locationId: fixture.locationId, lines: [{ ingredientId: fixture.ingredientAId, quantity: -1 }] })
    ).rejects.toThrow();
    const stock = await prisma.ingredientStock.findFirst({ where: { ingredientId: fixture.ingredientAId, locationId: fixture.locationId } });
    expect(stock).toBeNull();
  });

  it("can initialize a brand-new (never-tracked) ingredient stock row directly, not just reconcile an existing one", async () => {
    const fixture = await createFixture();
    const owner = ctxFor(fixture, "OWNER", "owner-1");

    const before = await prisma.ingredientStock.findFirst({ where: { ingredientId: fixture.ingredientAId, locationId: fixture.locationId } });
    expect(before).toBeNull();

    const result = await ingredients.bulkSetIngredientOpeningStock(owner, { locationId: fixture.locationId, lines: [{ ingredientId: fixture.ingredientAId, quantity: 12.4 }] });
    expect(result.results[0]).toMatchObject({ before: 0, after: 12.4 });
  });
});
