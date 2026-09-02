/**
 * INVENTURA — fizičko prebrojavanje zaliha. Vidi
 * packages/domain/inventory/inventura-service.ts za arhitekturu
 * (konkurentnost, STALE detekcija preko atomskog uslovnog upsert-a, atomska
 * potvrda cele sesije).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { ForbiddenError } from "@rcs/auth";
import { inventura, inventory, ingredients, recipes } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  colaId: string; // DIRECT_STOCK menu item
  biftekId: string; // RECIPE menu item (has a recipe line)
  fritezId: string; // NO_TRACKING menu item (never configured)
  brasnoId: string; // Ingredient
}

function context(fixture: Pick<Fixture, "restaurantId">, role: string, employeeId: string, locationIds: string[], permissions = new Set<string>()): AuthContext {
  return { userId: employeeId, employeeId, restaurantId: fixture.restaurantId, locationIds, roles: [role], permissions };
}
function ownerCtx(fixture: Fixture, employeeId = "owner-1") {
  return context(fixture, "OWNER", employeeId, [fixture.locationId, fixture.otherLocationId], new Set(["inventory.view", "inventory.manage", "inventory.count"]));
}
function managerCtx(fixture: Fixture, employeeId = "mgr-1") {
  return context(fixture, "MANAGER", employeeId, [fixture.locationId, fixture.otherLocationId], new Set(["inventory.view", "inventory.manage", "inventory.count"]));
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Inventura tenant", slug: `iv-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Branch" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" } });

  const owner: AuthContext = {
    userId: "owner-1", employeeId: "owner-1", restaurantId: restaurant.id,
    locationIds: [location.id, otherLocation.id], roles: ["OWNER"], permissions: new Set(["inventory.view", "inventory.manage", "inventory.count"]),
  };

  const cola = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Cola", slug: `cola-${randomUUID()}`, price: "300", taxRate: "20", preparationStation: "BAR" },
  });
  const biftek = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Biftek", slug: `biftek-${randomUUID()}`, price: "1200", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const fritez = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Salata", slug: `salata-${randomUUID()}`, price: "400", taxRate: "20", preparationStation: "KITCHEN" },
  });

  const brasno = await ingredients.createIngredient(owner, { name: "Brašno", unit: "KILOGRAM" });
  await ingredients.initializeStock(owner, { ingredientId: brasno.id, locationId: location.id, initialStock: 10 });
  await recipes.addRecipeLine(owner, biftek.id, { ingredientId: brasno.id, quantity: 0.5 });

  await inventory.initializeTracking(owner, { menuItemId: cola.id, locationId: location.id, initialStock: 20 });

  return {
    restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id,
    locationId: location.id, otherLocationId: otherLocation.id,
    colaId: cola.id, biftekId: biftek.id, fritezId: fritez.id, brasnoId: brasno.id,
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

async function countAndEnter(ctx: AuthContext, sessionId: string, target: { targetType: "INGREDIENT" | "MENU_ITEM"; ingredientId?: string; menuItemId?: string }, physicalQty: number) {
  const lineIds = await inventura.addLines(ctx, sessionId, { targets: [target] });
  await inventura.enterPhysicalQuantity(ctx, sessionId, lineIds[0], physicalQty);
  return lineIds[0];
}

describe("inventura: basic reconciliation outcomes", () => {
  it("exact match — no correction movement created", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 20);

    const confirmed = await inventura.confirmSession(owner, session.id, {});
    const line = confirmed.lines[0];
    expect(line.status).toBe("MATCH");
    expect(line.correctionMovementId).toBeNull();

    const movements = await prisma.inventoryMovement.findMany({ where: { menuItemId: fixture.colaId, type: "INVENTORY_CORRECTION" } });
    expect(movements).toHaveLength(0);
  });

  it("shortage (manjak) — negative correction, final stock = physical count", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 14);

    const confirmed = await inventura.confirmSession(owner, session.id, {});
    expect(confirmed.lines[0].status).toBe("SHORTAGE");

    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    expect(invItem.currentStock.toString()).toBe("14");

    const mov = await prisma.inventoryMovement.findFirstOrThrow({ where: { menuItemId: fixture.colaId, type: "INVENTORY_CORRECTION" } });
    expect(Number(mov.quantityDelta)).toBe(-6);
    expect(mov.referenceType).toBe("INVENTORY_COUNT");
    expect(mov.referenceId).toBe(session.id);
  });

  it("surplus (višak) — positive correction", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 25);

    const confirmed = await inventura.confirmSession(owner, session.id, {});
    expect(confirmed.lines[0].status).toBe("SURPLUS");
    const mov = await prisma.inventoryMovement.findFirstOrThrow({ where: { menuItemId: fixture.colaId, type: "INVENTORY_CORRECTION" } });
    expect(Number(mov.quantityDelta)).toBe(5);
  });

  it("negative SYSTEM stock is fully supported — e.g. system -3, physical 2 -> +5 surplus, final stock 2", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    // Force system stock to -3 via a direct write (simulating accumulated oversell).
    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    await prisma.inventoryItem.update({ where: { id: invItem.id }, data: { currentStock: -3 } });

    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 2);
    const confirmed = await inventura.confirmSession(owner, session.id, {});

    expect(confirmed.lines[0].status).toBe("SURPLUS");
    const mov = await prisma.inventoryMovement.findFirstOrThrow({ where: { menuItemId: fixture.colaId, type: "INVENTORY_CORRECTION" } });
    expect(Number(mov.quantityDelta)).toBe(5);
    expect(Number(mov.quantityBefore)).toBe(-3);
    expect(Number(mov.quantityAfter)).toBe(2);

    const reloaded = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(reloaded.currentStock.toString()).toBe("2");
  });

  it("rejects a negative physical quantity", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    const [lineId] = await inventura.addLines(owner, session.id, { targets: [{ targetType: "MENU_ITEM", menuItemId: fixture.colaId }] });
    await expect(inventura.enterPhysicalQuantity(owner, session.id, lineId, -1)).rejects.toThrow(/negativna/);
  });

  it("an uncounted line does not block confirmation and stays NOT_COUNTED", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    await inventura.addLines(owner, session.id, { targets: [{ targetType: "MENU_ITEM", menuItemId: fixture.colaId }] }); // never counted

    const confirmed = await inventura.confirmSession(owner, session.id, {});
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.lines[0].status).toBe("NOT_COUNTED");
    expect(confirmed.lines[0].correctionMovementId).toBeNull();
  });
});

describe("inventura: scope — Ingredients + DIRECT_STOCK only", () => {
  it("supports a mixed session with both an Ingredient and a DIRECT_STOCK item", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    await countAndEnter(owner, session.id, { targetType: "INGREDIENT", ingredientId: fixture.brasnoId }, 8.5);
    await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 20);

    const confirmed = await inventura.confirmSession(owner, session.id, {});
    expect(confirmed.lines).toHaveLength(2);

    const ingLine = confirmed.lines.find((l) => l.targetType === "INGREDIENT")!;
    expect(ingLine.status).toBe("SHORTAGE");
    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: fixture.brasnoId, locationId: fixture.locationId } });
    expect(stock.currentStock.toString()).toBe("8.5");

    const ingMov = await prisma.ingredientMovement.findFirstOrThrow({ where: { ingredientId: fixture.brasnoId, type: "INVENTORY_CORRECTION" } });
    expect(ingMov.referenceType).toBe("INVENTORY_COUNT");
    expect(ingMov.referenceId).toBe(session.id);
  });

  it("rejects adding a RECIPE-governed menu item", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    await expect(
      inventura.addLines(owner, session.id, { targets: [{ targetType: "MENU_ITEM", menuItemId: fixture.biftekId }] })
    ).rejects.toThrow(/normativ/);
  });

  it("rejects adding a NO_TRACKING menu item", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    await expect(
      inventura.addLines(owner, session.id, { targets: [{ targetType: "MENU_ITEM", menuItemId: fixture.fritezId }] })
    ).rejects.toThrow(/praćenje zaliha/);
  });
});

describe("inventura: concurrency / STALE detection", () => {
  it("detects a stale line when live stock changed after the snapshot, and does not apply a wrong correction", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const manager = managerCtx(fixture, "mgr-2");

    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    const lineId = await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 20); // matches snapshot (20) for now

    // Concurrent RECEIPT changes live stock after the snapshot was taken.
    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    await inventory.receiveStock(manager, invItem.id, { quantity: 5 }); // live is now 25, snapshot still 20

    await expect(inventura.confirmSession(owner, session.id, {})).rejects.toThrow(/promenilo/);

    const line = await prisma.inventoryCountLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.status).toBe("STALE");

    // Session must remain OPEN — the whole transaction rolled back.
    const reloadedSession = await prisma.inventoryCountSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(reloadedSession.status).toBe("OPEN");

    // Stock must be untouched by the failed confirm attempt.
    const reloadedStock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(reloadedStock.currentStock.toString()).toBe("25");
  });

  it("a normal MANAGER cannot override a stale line — must recount instead", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const manager = managerCtx(fixture);

    const session = await inventura.startOrResumeSession(manager, { locationId: fixture.locationId });
    const lineId = await countAndEnter(manager, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 20);

    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    await inventory.receiveStock(owner, invItem.id, { quantity: 3 });

    await expect(inventura.confirmSession(manager, session.id, { overrideStaleLineIds: [lineId] })).rejects.toThrow(ForbiddenError);
  });

  it("OWNER/ADMIN may override a stale line — correction is computed against the FRESH live value, and is audited", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const manager = managerCtx(fixture);

    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    const lineId = await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 20); // snapshot 20

    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    await inventory.receiveStock(manager, invItem.id, { quantity: 5 }); // live now 25

    const confirmed = await inventura.confirmSession(owner, session.id, { overrideStaleLineIds: [lineId] });
    const line = confirmed.lines.find((l) => l.id === lineId)!;
    // Physical count (20) vs the FRESH live value (25) at override time -> shortage of 5, NOT vs the stale snapshot (20 -> 20 = no-op).
    expect(line.status).toBe("SHORTAGE");

    const mov = await prisma.inventoryMovement.findFirstOrThrow({ where: { menuItemId: fixture.colaId, type: "INVENTORY_CORRECTION" } });
    expect(Number(mov.quantityBefore)).toBe(25);
    expect(Number(mov.quantityAfter)).toBe(20);
    expect(Number(mov.quantityDelta)).toBe(-5);

    const finalStock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(finalStock.currentStock.toString()).toBe("20");

    const auditEntry = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "InventoryCountSession", entityId: session.id, action: "inventory_count.confirmed" } });
    expect((auditEntry.newValue as { overrideCount: number }).overrideCount).toBe(1);
  });

  it("preserves a concurrent SALE movement — it is never overwritten by the correction", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    const lineId = await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 20);

    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    // Simulate a concurrent SALE movement directly (idempotency-keyed by paymentId+menuItemId, same shape billing writes).
    await prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({ where: { id: invItem.id }, data: { currentStock: { decrement: 2 } } });
      await tx.inventoryMovement.create({
        data: {
          restaurantId: fixture.restaurantId, locationId: fixture.locationId, menuItemId: fixture.colaId, inventoryItemId: invItem.id,
          type: "SALE", quantityDelta: -2, quantityBefore: 20, quantityAfter: 18, paymentId: randomUUID(), reason: "Prodaja",
        },
      });
    });

    const salesBefore = await prisma.inventoryMovement.count({ where: { menuItemId: fixture.colaId, type: "SALE" } });

    // Correctly detected as stale (18 != snapshot 20) and rejected without override.
    await expect(inventura.confirmSession(owner, session.id, {})).rejects.toThrow(/promenilo/);

    const salesAfter = await prisma.inventoryMovement.count({ where: { menuItemId: fixture.colaId, type: "SALE" } });
    expect(salesAfter).toBe(salesBefore); // the SALE movement itself is completely untouched

    // Recount re-baselines and then a normal confirm succeeds and preserves the SALE row.
    await inventura.recountLine(owner, session.id, lineId);
    await inventura.enterPhysicalQuantity(owner, session.id, lineId, 18);
    await inventura.confirmSession(owner, session.id, {});
    const salesFinal = await prisma.inventoryMovement.count({ where: { menuItemId: fixture.colaId, type: "SALE" } });
    expect(salesFinal).toBe(salesBefore);
  });

  it("preserves a concurrent RECEIPT movement — it is never overwritten by the correction", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    const lineId = await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 20);

    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    const receiveResult = await inventory.receiveStock(owner, invItem.id, { quantity: 10 });
    expect(Number(receiveResult.after)).toBe(30);

    const receiptsBefore = await prisma.inventoryMovement.count({ where: { menuItemId: fixture.colaId, type: "RECEIPT" } });

    await inventura.recountLine(owner, session.id, lineId);
    await inventura.enterPhysicalQuantity(owner, session.id, lineId, 30); // matches the post-receipt live value exactly
    const confirmed = await inventura.confirmSession(owner, session.id, {});
    expect(confirmed.lines[0].status).toBe("MATCH"); // no correction movement needed

    const receiptsAfter = await prisma.inventoryMovement.count({ where: { menuItemId: fixture.colaId, type: "RECEIPT" } });
    expect(receiptsAfter).toBe(receiptsBefore); // RECEIPT row untouched
  });
});

describe("inventura: confirmation safety", () => {
  it("is safe against a double confirm — the second call is rejected, no double correction", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 15);

    await inventura.confirmSession(owner, session.id, {});
    await expect(inventura.confirmSession(owner, session.id, {})).rejects.toThrow(/već potvrđena/);

    const corrections = await prisma.inventoryMovement.count({ where: { menuItemId: fixture.colaId, type: "INVENTORY_CORRECTION" } });
    expect(corrections).toBe(1);
  });

  it("rolls back the ENTIRE confirmation when one line among several is stale — no partial confirmation", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const manager = managerCtx(fixture);

    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    const brasnoLine = await countAndEnter(owner, session.id, { targetType: "INGREDIENT", ingredientId: fixture.brasnoId }, 9); // will succeed
    await countAndEnter(owner, session.id, { targetType: "MENU_ITEM", menuItemId: fixture.colaId }, 20); // will go stale

    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    await inventory.receiveStock(manager, invItem.id, { quantity: 1 }); // makes the cola line stale

    await expect(inventura.confirmSession(owner, session.id, {})).rejects.toThrow(/promenilo/);

    // The Brašno line must NOT have been committed either, even though it individually would have succeeded.
    // The line's SHORTAGE status is the pre-confirm PREVIEW set by enterPhysicalQuantity
    // (physicalQty vs snapshot) — that stays as-is (the rollback never touched it). What
    // must NOT have happened is any actual finalized correction/movement/stock change.
    const brasnoLineRow = await prisma.inventoryCountLine.findUniqueOrThrow({ where: { id: brasnoLine } });
    expect(brasnoLineRow.correctionMovementId).toBeNull();
    const brasnoMovements = await prisma.ingredientMovement.count({ where: { ingredientId: fixture.brasnoId, type: "INVENTORY_CORRECTION" } });
    expect(brasnoMovements).toBe(0);
    const brasnoStock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: fixture.brasnoId, locationId: fixture.locationId } });
    expect(brasnoStock.currentStock.toString()).toBe("10"); // untouched, still original

    const reloadedSession = await prisma.inventoryCountSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(reloadedSession.status).toBe("OPEN");
  });
});

describe("inventura: isolation", () => {
  it("is scoped per restaurant — a session cannot be confirmed/viewed by another restaurant's context", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const session = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });

    const foreignOwner: AuthContext = {
      userId: "foreign", employeeId: "foreign", restaurantId: fixture.otherRestaurantId,
      locationIds: [fixture.locationId], roles: ["OWNER"], permissions: new Set(["inventory.view", "inventory.count"]),
    };
    await expect(inventura.getSession(foreignOwner, session.id)).rejects.toThrow(/nije pronađena/);
  });

  it("resuming a session only finds an OPEN session for the SAME location", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const first = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    const other = await inventura.startOrResumeSession(owner, { locationId: fixture.otherLocationId });
    expect(other.id).not.toBe(first.id);

    const resumed = await inventura.startOrResumeSession(owner, { locationId: fixture.locationId });
    expect(resumed.id).toBe(first.id); // resumes, does not create a duplicate
  });
});
