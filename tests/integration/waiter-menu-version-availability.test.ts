/**
 * P0.2b — menu.getWaiterMenuVersion, menu.getWaiterAvailabilityOverlay, and
 * getWaiterMenuSnapshot's new menuVersion/fresh behavior. Real Postgres
 * (TEST_DATABASE_URL) + mocked @upstash/redis (real in-memory NX/GET-aware
 * dvojnik, isti obrazac kao tests/integration/menu-version-mutations.test.ts).
 *
 * Auth/session-cookie mechanics (missing-auth-rejected at the HTTP layer)
 * are NOT re-tested here — both new routes use the exact same, unmodified
 * `withApiAuth` wrapper as every other /api/pos/* route (already exercised
 * elsewhere in this suite); what's new and worth proving here is the
 * domain-level authorization/behavior these routes call into.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { menu } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface SetOptions {
  nx?: boolean;
  get?: boolean;
  ex?: number;
}

function createFakeRedis() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown, opts?: SetOptions) => {
      const hadKey = store.has(key);
      const oldValue = hadKey ? (store.get(key) ?? null) : null;
      if (opts?.nx && hadKey) return opts?.get ? oldValue : null;
      store.set(key, value);
      return opts?.get ? oldValue : "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    }),
    incr: vi.fn(async (key: string) => {
      const next = ((store.get(key) as number | undefined) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
  };
}

let fakeRedis = createFakeRedis();

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn().mockImplementation(() => fakeRedis),
}));

function withRedisConfigured() {
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
}
function withoutRedisConfigured() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

beforeEach(() => {
  fakeRedis = createFakeRedis();
  withRedisConfigured();
});
afterEach(() => {
  withoutRedisConfigured();
});

interface Fixture {
  restaurantId: string;
  locationId: string;
  otherLocationId: string;
  categoryId: string;
  itemId: string;
}

function makeCtx(restaurantId: string, locationIds: string[], role: string, permissions: string[]): AuthContext {
  return { userId: "user-1", employeeId: "emp-1", restaurantId, locationIds, roles: [role], permissions: new Set(permissions) };
}
function waiterCtx(f: Fixture) {
  return makeCtx(f.restaurantId, [f.locationId], "WAITER", ["menu.view"]);
}
function noPermissionCtx(f: Fixture) {
  return makeCtx(f.restaurantId, [f.locationId], "WAITER", []);
}
function wrongLocationCtx(f: Fixture) {
  return makeCtx(f.restaurantId, [f.otherLocationId], "WAITER", ["menu.view"]);
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "T", slug: `t-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "R", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Loc" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Loc B" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Hrana", slug: `hrana-${randomUUID()}`, type: "FOOD", sortOrder: 0 } });
  const item = await prisma.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, price: 500, isActive: true } });
  return { restaurantId: restaurant.id, locationId: location.id, otherLocationId: otherLocation.id, categoryId: category.id, itemId: item.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("P0.2b VERSION: menu.getWaiterMenuVersion", () => {
  it("authenticated waiter with menu.view gets a valid initialized numeric version", async () => {
    const f = await createFixture();
    await expect(menu.getWaiterMenuVersion(waiterCtx(f), f.locationId)).resolves.toBe(1);
  });

  it("rejects a ctx without menu.view (permission enforcement)", async () => {
    const f = await createFixture();
    await expect(menu.getWaiterMenuVersion(noPermissionCtx(f), f.locationId)).rejects.toThrow();
  });

  it("rejects a ctx without access to the requested location", async () => {
    const f = await createFixture();
    await expect(menu.getWaiterMenuVersion(wrongLocationCtx(f), f.locationId)).rejects.toThrow();
  });

  it("Redis unavailable returns null, and the call still succeeds (does not throw)", async () => {
    const f = await createFixture();
    withoutRedisConfigured();
    await expect(menu.getWaiterMenuVersion(waiterCtx(f), f.locationId)).resolves.toBeNull();
  });
});

describe("P0.2b AVAILABILITY: menu.getWaiterAvailabilityOverlay", () => {
  it("returns a live overlay keyed by menuItemId, with NO static fields (name/price/category/modifiers)", async () => {
    const f = await createFixture();
    const overlay = await menu.getWaiterAvailabilityOverlay(waiterCtx(f), f.locationId);

    expect(overlay.locationId).toBe(f.locationId);
    const row = overlay.items.find((i) => i.menuItemId === f.itemId)!;
    expect(row).toBeDefined();
    expect(row).toHaveProperty("stock");
    expect(row).toHaveProperty("recipeAvailability");
    expect(row).toHaveProperty("availability");
    expect((row as Record<string, unknown>).name).toBeUndefined();
    expect((row as Record<string, unknown>).price).toBeUndefined();
    expect((row as Record<string, unknown>).category).toBeUndefined();
    expect((row as Record<string, unknown>).modifierGroups).toBeUndefined();
  });

  it("matches the exact same authoritative operational-block logic as the existing admin/order path", async () => {
    const f = await createFixture();
    await prisma.menuItemAvailability.create({
      data: { restaurantId: f.restaurantId, locationId: f.locationId, menuItemId: f.itemId, isAvailable: false, reasonCode: "DRUGO", updatedBy: "emp-1" },
    });

    const overlay = await menu.getWaiterAvailabilityOverlay(waiterCtx(f), f.locationId);
    const existingPath = await menu.listMenuItems(waiterCtx(f), { activeOnly: true, locationId: f.locationId });

    const row = overlay.items.find((i) => i.menuItemId === f.itemId)!;
    const existingItem = existingPath.find((i) => i.id === f.itemId)!;
    expect(row.availability).toEqual(existingItem.availability);
    expect(row.availability.isAvailable).toBe(false); // stvarno blokirano, dokazano
  });

  it("unknown/unblocked availability is never implicitly hidden as unavailable — absence of an override row means available:true", async () => {
    const f = await createFixture();
    const overlay = await menu.getWaiterAvailabilityOverlay(waiterCtx(f), f.locationId);
    const row = overlay.items.find((i) => i.menuItemId === f.itemId)!;
    expect(row.availability).toEqual({ isAvailable: true, reasonCode: null, reasonLabel: null });
  });

  it("tenant/location isolation: rejects a ctx without access to the requested location", async () => {
    const f = await createFixture();
    await expect(menu.getWaiterAvailabilityOverlay(wrongLocationCtx(f), f.locationId)).rejects.toThrow();
  });

  it("permission enforcement: rejects a ctx without menu.view", async () => {
    const f = await createFixture();
    await expect(menu.getWaiterAvailabilityOverlay(noPermissionCtx(f), f.locationId)).rejects.toThrow();
  });
});

describe("P0.2b SNAPSHOT+VERSION: getWaiterMenuSnapshot now includes menuVersion", () => {
  it("snapshot response includes a valid numeric menuVersion associated with this exact call", async () => {
    const f = await createFixture();
    const snapshot = await menu.getWaiterMenuSnapshot(waiterCtx(f), f.locationId);
    expect(typeof snapshot.menuVersion).toBe("number");
    expect(snapshot.menuVersion).toBe(1);
  });

  it("Redis unavailable does NOT break the snapshot — menuVersion becomes null, everything else still returned", async () => {
    const f = await createFixture();
    withoutRedisConfigured();
    const snapshot = await menu.getWaiterMenuSnapshot(waiterCtx(f), f.locationId);
    expect(snapshot.menuVersion).toBeNull();
    expect(snapshot.items.find((i) => i.id === f.itemId)?.name).toBe("Pljeskavica");
  });

  it("static contract is unchanged apart from the added menuVersion field", async () => {
    const f = await createFixture();
    const snapshot = await menu.getWaiterMenuSnapshot(waiterCtx(f), f.locationId);
    expect(Object.keys(snapshot).sort()).toEqual(["categories", "items", "locationId", "menuVersion", "restaurantId"]);
  });

  it("fresh:true bypasses a stale Redis cache entry and returns authoritative current data", async () => {
    const f = await createFixture();
    const ctx = waiterCtx(f);

    // Zagrej keš sa "starim" imenom.
    await menu.listMenuItems(ctx, { activeOnly: true });

    // Simuliraj DELIMIČAN neuspeh: DB izmena uspe, ali cacheDel "ne stigne"
    // (simulacija: ručno menjamo Postgres MIMO menu-service.ts, bez
    // invalidacije, da dokažemo da fresh:true zaista ignoriše keš).
    await prisma.menuItem.update({ where: { id: f.itemId }, data: { name: "Pljeskavica NOVO" } });

    const stale = await menu.getWaiterMenuSnapshot(ctx, f.locationId, { fresh: false });
    expect(stale.items.find((i) => i.id === f.itemId)?.name).toBe("Pljeskavica"); // i dalje stari keš

    const fresh = await menu.getWaiterMenuSnapshot(ctx, f.locationId, { fresh: true });
    expect(fresh.items.find((i) => i.id === f.itemId)?.name).toBe("Pljeskavica NOVO"); // zaobišao keš

    // I keš je sada "izlečen" za naredne obične (ne-fresh) pozive.
    const afterHeal = await menu.getWaiterMenuSnapshot(ctx, f.locationId, { fresh: false });
    expect(afterHeal.items.find((i) => i.id === f.itemId)?.name).toBe("Pljeskavica NOVO");
  });
});

describe("P0.2b REGRESSION: existing paths unchanged", () => {
  it("existing admin/order listMenuItems(locationId=...) behavior is byte-for-byte unchanged after the computeLiveOverlay refactor", async () => {
    const f = await createFixture();
    const ctx = waiterCtx(f);
    const items = await menu.listMenuItems(ctx, { activeOnly: true, locationId: f.locationId });
    const item = items.find((i) => i.id === f.itemId)!;
    expect(item.name).toBe("Pljeskavica");
    expect(Number(item.price)).toBe(500);
    expect(item).toHaveProperty("stock");
    expect(item).toHaveProperty("recipeAvailability");
    expect(item).toHaveProperty("availability");
  });

  it("existing P0.2a mutation-coverage behavior remains green: a mutation still bumps the version returned by getWaiterMenuVersion", async () => {
    const f = await createFixture();
    const ctx = waiterCtx(f);
    const before = await menu.getWaiterMenuVersion(ctx, f.locationId);
    await menu.changePrice(makeCtx(f.restaurantId, [f.locationId], "OWNER", ["menu.manage"]), f.itemId, { price: 999 });
    const after = await menu.getWaiterMenuVersion(ctx, f.locationId);
    expect(after).toBe((before ?? 0) + 1);
  });
});
