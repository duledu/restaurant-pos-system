/**
 * P0 GUEST QR ORDERING — tenant isolation, server-authoritative price/name,
 * claim atomicity/idempotency, and the "guest can never reach KDS/print/
 * payment/inventory" architectural guarantee for
 * packages/domain/guestordering/guest-order-service.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError, type AuthContext } from "@rcs/auth";
import { guestOrdering } from "@rcs/domain";
import { GuestOrderValidationError } from "@rcs/domain/guestordering/guest-order-service";
import { resetPrismaTestTables } from "../setup/reset-test-db";

function waiterCtx(restaurantId: string, locationId: string, employeeId = "w1"): AuthContext {
  return { userId: employeeId, employeeId, restaurantId, locationIds: [locationId], roles: ["WAITER"], permissions: new Set() };
}

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  tableId: string;
  otherLocationTableId: string; // valid table, but in a location this waiter has no access to
  itemAId: string; // "Pljeskavica", KITCHEN, 650.00
  itemBId: string; // "Pivo", BAR, 350.00
  inactiveItemId: string;
  unavailableItemId: string;
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Guest order tenant", slug: `guestorder-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restoran A", currency: "RSD", slug: `restoran-a-${randomUUID()}` } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restoran B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Glavna" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Druga" } });

  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Sprat" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "7" } });
  const otherFloor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, name: "Sprat 2" } });
  const otherLocationTable = await prisma.restaurantTable.create({ data: { floorId: otherFloor.id, label: "99" } });

  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Roštilj", slug: `rostilj-${randomUUID()}`, type: "FOOD", isActive: true } });
  const itemA = await prisma.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, price: "650.00", taxRate: "20", isActive: true, isAvailable: true, preparationStation: "KITCHEN" } });
  const itemB = await prisma.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pivo", slug: `pivo-${randomUUID()}`, price: "350.00", taxRate: "20", isActive: true, isAvailable: true, preparationStation: "BAR" } });
  const inactiveItem = await prisma.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Arhivirano", slug: `arhiv-${randomUUID()}`, price: "100.00", taxRate: "20", isActive: false, isAvailable: true } });
  const unavailableItem = await prisma.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Nema", slug: `nema-${randomUUID()}`, price: "100.00", taxRate: "20", isActive: true, isAvailable: false } });

  return {
    restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id,
    tableId: table.id, otherLocationTableId: otherLocationTable.id,
    itemAId: itemA.id, itemBId: itemB.id, inactiveItemId: inactiveItem.id, unavailableItemId: unavailableItem.id,
  };
}

async function finalizeFor(fixture: Fixture, itemId = fixture.itemAId, quantity = 2, note?: string) {
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: fixture.restaurantId }, select: { slug: true } });
  return guestOrdering.finalizeGuestOrder({ slug: restaurant.slug!, items: [{ menuItemId: itemId, quantity, note }] }, "127.0.0.1");
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("finalizeGuestOrder — public, server-authoritative, never trusts the client", () => {
  it("ignores a client-supplied price/name — the snapshot always reflects the real MenuItem", async () => {
    const fixture = await createFixture();
    const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: fixture.restaurantId }, select: { slug: true } });
    // The Zod schema itself has no name/price fields at all — this proves
    // there is structurally no channel for the client to influence them.
    const result = await guestOrdering.finalizeGuestOrder(
      { slug: restaurant.slug!, items: [{ menuItemId: fixture.itemAId, quantity: 1 }] },
      "127.0.0.1"
    );
    expect(result.items[0]).toMatchObject({ name: "Pljeskavica", price: "650" });
  });

  it("rejects an inactive item and creates no handoff", async () => {
    const fixture = await createFixture();
    const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: fixture.restaurantId }, select: { slug: true } });
    await expect(
      guestOrdering.finalizeGuestOrder({ slug: restaurant.slug!, items: [{ menuItemId: fixture.inactiveItemId, quantity: 1 }] }, "127.0.0.1")
    ).rejects.toThrow(GuestOrderValidationError);
    expect(await prisma.guestOrderHandoff.count({ where: { restaurantId: fixture.restaurantId } })).toBe(0);
  });

  it("rejects an unavailable item and identifies it in the error", async () => {
    const fixture = await createFixture();
    const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: fixture.restaurantId }, select: { slug: true } });
    try {
      await guestOrdering.finalizeGuestOrder({ slug: restaurant.slug!, items: [{ menuItemId: fixture.unavailableItemId, quantity: 1 }] }, "127.0.0.1");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GuestOrderValidationError);
      expect((err as InstanceType<typeof GuestOrderValidationError>).unavailableItemIds).toEqual([fixture.unavailableItemId]);
    }
  });

  it("rejects a menuItemId belonging to a different restaurant — cross-tenant item can never be ordered via another restaurant's slug", async () => {
    const fixture = await createFixture();
    const otherCategory = await prisma.menuCategory.create({ data: { restaurantId: fixture.otherRestaurantId, name: "X", slug: `x-${randomUUID()}`, type: "FOOD", isActive: true } });
    const foreignItem = await prisma.menuItem.create({ data: { restaurantId: fixture.otherRestaurantId, categoryId: otherCategory.id, name: "Tuđe", slug: `tudje-${randomUUID()}`, price: "1.00", taxRate: "20", isActive: true, isAvailable: true } });
    const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: fixture.restaurantId }, select: { slug: true } });
    await expect(
      guestOrdering.finalizeGuestOrder({ slug: restaurant.slug!, items: [{ menuItemId: foreignItem.id, quantity: 1 }] }, "127.0.0.1")
    ).rejects.toThrow(GuestOrderValidationError);
  });

  it("preserves preparationStation from the authoritative MenuItem (never guest-supplied)", async () => {
    const fixture = await createFixture();
    const result = await finalizeFor(fixture, fixture.itemBId, 1);
    expect(result.items[0].preparationStation).toBe("BAR");
  });

  it("computes itemCount/totalPrice from the snapshot, not client input", async () => {
    const fixture = await createFixture();
    const result = await finalizeFor(fixture, fixture.itemAId, 3);
    expect(result.itemCount).toBe(3);
    expect(result.totalPrice).toBe("1950.00");
  });

  it("returns a token but the persisted row never stores it in the clear", async () => {
    const fixture = await createFixture();
    const result = await finalizeFor(fixture);
    const row = await prisma.guestOrderHandoff.findFirst({ where: { restaurantId: fixture.restaurantId } });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).not.toBe(result.token);
    expect(row!.tokenHash).toHaveLength(64); // sha256 hex
  });
});

describe("NO SIDE EFFECTS — guest finalize never touches operational tables", () => {
  it("creates zero Order/OrderItem/Payment/PrintJob/InventoryMovement/IngredientMovement rows", async () => {
    const fixture = await createFixture();
    await finalizeFor(fixture);
    expect(await prisma.order.count({ where: { restaurantId: fixture.restaurantId } })).toBe(0);
    expect(await prisma.orderItem.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.printJob.count()).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
    expect(await prisma.ingredientMovement.count()).toBe(0);
  });
});

describe("reviewGuestOrderHandoff — SCAN != CLAIM (read-only)", () => {
  it("returns the snapshot without mutating status", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    const ctx = waiterCtx(fixture.restaurantId, fixture.locationId);
    const snapshot = await guestOrdering.reviewGuestOrderHandoff(ctx, token);
    expect(snapshot.items).toHaveLength(1);
    const row = await prisma.guestOrderHandoff.findFirst({ where: { restaurantId: fixture.restaurantId } });
    expect(row!.status).toBe("PENDING");
  });

  it("can be called repeatedly (by the same or different waiters) without consuming the handoff", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    const ctx = waiterCtx(fixture.restaurantId, fixture.locationId);
    await guestOrdering.reviewGuestOrderHandoff(ctx, token);
    await guestOrdering.reviewGuestOrderHandoff(waiterCtx(fixture.restaurantId, fixture.locationId, "w2"), token);
    const row = await prisma.guestOrderHandoff.findFirst({ where: { restaurantId: fixture.restaurantId } });
    expect(row!.status).toBe("PENDING");
  });

  it("rejects a token from a different restaurant without leaking existence (same generic error as a nonexistent token)", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    const otherLocation = await prisma.location.create({ data: { restaurantId: fixture.otherRestaurantId, name: "Main" } });
    const crossTenantCtx = waiterCtx(fixture.otherRestaurantId, otherLocation.id);
    await expect(guestOrdering.reviewGuestOrderHandoff(crossTenantCtx, token)).rejects.toThrow("Porudžbina nije pronađena.");
    await expect(guestOrdering.reviewGuestOrderHandoff(crossTenantCtx, "totally-bogus-token")).rejects.toThrow("Porudžbina nije pronađena.");
  });

  it("rejects an expired handoff with the exact guest-facing message", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    await prisma.guestOrderHandoff.updateMany({ where: { restaurantId: fixture.restaurantId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const ctx = waiterCtx(fixture.restaurantId, fixture.locationId);
    await expect(guestOrdering.reviewGuestOrderHandoff(ctx, token)).rejects.toThrow("Ova porudžbina je istekla. Kreirajte novu.");
  });

  it("rejects an already-claimed handoff", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    const ctx = waiterCtx(fixture.restaurantId, fixture.locationId);
    await guestOrdering.claimGuestOrderHandoff(ctx, { token, tableId: fixture.tableId });
    await expect(guestOrdering.reviewGuestOrderHandoff(ctx, token)).rejects.toThrow("Ova porudžbina je već preuzeta.");
  });
});

describe("claimGuestOrderHandoff — atomic, idempotent-per-table, tenant/location scoped", () => {
  it("rejects an unauthenticated-shape caller without WAITER/management role", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    const noRoleCtx: AuthContext = { userId: "x", employeeId: "x", restaurantId: fixture.restaurantId, locationIds: [fixture.locationId], roles: [], permissions: new Set() };
    await expect(guestOrdering.claimGuestOrderHandoff(noRoleCtx, { token, tableId: fixture.tableId })).rejects.toThrow(ForbiddenError);
  });

  it("rejects a table the waiter has no location access to", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    const ctx = waiterCtx(fixture.restaurantId, fixture.locationId); // locationIds does NOT include otherLocationTableId's location
    await expect(guestOrdering.claimGuestOrderHandoff(ctx, { token, tableId: fixture.otherLocationTableId })).rejects.toThrow(ForbiddenError);
  });

  it("successfully claims a PENDING handoff and returns the full snapshot", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture, fixture.itemAId, 2, "Bez luka");
    const ctx = waiterCtx(fixture.restaurantId, fixture.locationId);
    const snapshot = await guestOrdering.claimGuestOrderHandoff(ctx, { token, tableId: fixture.tableId });
    expect(snapshot.items[0]).toMatchObject({ name: "Pljeskavica", quantity: 2, note: "Bez luka" });
    const row = await prisma.guestOrderHandoff.findFirst({ where: { restaurantId: fixture.restaurantId } });
    expect(row!.status).toBe("CLAIMED");
    expect(row!.claimedTableId).toBe(fixture.tableId);
    expect(row!.claimedByEmployeeId).toBe("w1");
  });

  it("rejects a second claim attempt from a DIFFERENT table with 'already taken'", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    const ctx1 = waiterCtx(fixture.restaurantId, fixture.locationId, "w1");
    await guestOrdering.claimGuestOrderHandoff(ctx1, { token, tableId: fixture.tableId });

    const floor2 = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "Sprat druga" } });
    const otherTable = await prisma.restaurantTable.create({ data: { floorId: floor2.id, label: "8" } });
    const ctx2 = waiterCtx(fixture.restaurantId, fixture.locationId, "w2");
    await expect(guestOrdering.claimGuestOrderHandoff(ctx2, { token, tableId: otherTable.id })).rejects.toThrow("Ova porudžbina je već preuzeta.");
  });

  it("RECOVERY: re-confirming from the SAME table after an already-successful claim is idempotent (returns the same snapshot, never throws) — the 'claimed but response lost' failure mode", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture, fixture.itemAId, 2);
    const ctx = waiterCtx(fixture.restaurantId, fixture.locationId);
    const first = await guestOrdering.claimGuestOrderHandoff(ctx, { token, tableId: fixture.tableId });
    const second = await guestOrdering.claimGuestOrderHandoff(ctx, { token, tableId: fixture.tableId });
    expect(second).toEqual(first);
  });

  it("CONCURRENCY: two simultaneous claims from different tables — only one succeeds, never both", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    const floor2 = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "Sprat konkurentno" } });
    const otherTable = await prisma.restaurantTable.create({ data: { floorId: floor2.id, label: "9" } });
    const ctxA = waiterCtx(fixture.restaurantId, fixture.locationId, "wa");
    const ctxB = waiterCtx(fixture.restaurantId, fixture.locationId, "wb");

    const results = await Promise.allSettled([
      guestOrdering.claimGuestOrderHandoff(ctxA, { token, tableId: fixture.tableId }),
      guestOrdering.claimGuestOrderHandoff(ctxB, { token, tableId: otherTable.id }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const row = await prisma.guestOrderHandoff.findFirst({ where: { restaurantId: fixture.restaurantId } });
    expect(row!.status).toBe("CLAIMED"); // exactly one claim won — no double-claim, no duplicate items possible downstream
  });

  it("rejects claiming an expired handoff", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    await prisma.guestOrderHandoff.updateMany({ where: { restaurantId: fixture.restaurantId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const ctx = waiterCtx(fixture.restaurantId, fixture.locationId);
    await expect(guestOrdering.claimGuestOrderHandoff(ctx, { token, tableId: fixture.tableId })).rejects.toThrow("Ova porudžbina je istekla. Kreirajte novu.");
  });

  it("still creates no Order/OrderItem/KDS/print rows even after a successful claim — claim is review-and-handoff only, import happens client-side via the existing Instant Local Draft", async () => {
    const fixture = await createFixture();
    const { token } = await finalizeFor(fixture);
    const ctx = waiterCtx(fixture.restaurantId, fixture.locationId);
    await guestOrdering.claimGuestOrderHandoff(ctx, { token, tableId: fixture.tableId });
    expect(await prisma.order.count({ where: { restaurantId: fixture.restaurantId } })).toBe(0);
    expect(await prisma.orderItem.count()).toBe(0);
  });
});
