/**
 * P0.2b CORRECTION — snapshot/menuVersion self-consistency.
 *
 * Proves getWaiterMenuSnapshot's before/after version-check-with-bounded-
 * retry algorithm using a DETERMINISTIC scripted Redis mock: the version
 * key's `SET ... NX GET` reply is scripted to return an exact, controlled
 * sequence of "previous value" results across successive calls — this lets
 * us simulate "a mutation landed mid-fetch" (versionBefore != versionAfter)
 * without any real timing/concurrency race, which would be flaky.
 *
 * Real Postgres (TEST_DATABASE_URL) for categories/items — only the
 * version-key reads are scripted; everything else behaves normally.
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

const VERSION_KEY_SUFFIX = ":menu-version";

/** `sequence` entries: a number = "the version key already existed with
 * this value" (NX blocks overwrite, GET returns it unchanged — exactly
 * what a real Redis SET NX GET reply looks like for an existing counter);
 * `"error"` = simulate a Redis failure on that specific call. Every OTHER
 * key (categories/menu-items cache) behaves like a normal, real in-memory
 * Redis with correct NX/GET semantics, unaffected by the script. */
function createScriptedRedis(sequence: (number | "error")[]) {
  const store = new Map<string, unknown>();
  let versionCallIndex = 0;
  const versionCalls: unknown[] = [];

  const set = vi.fn(async (key: string, value: unknown, opts?: SetOptions) => {
    if (key.endsWith(VERSION_KEY_SUFFIX)) {
      const scripted = sequence[Math.min(versionCallIndex, sequence.length - 1)];
      versionCallIndex++;
      versionCalls.push(scripted);
      if (scripted === "error") throw new Error("simulated Upstash outage");
      return scripted; // "previous value" — a real existing counter, NX blocks overwrite
    }
    const hadKey = store.has(key);
    const oldValue = hadKey ? (store.get(key) ?? null) : null;
    if (opts?.nx && hadKey) return opts?.get ? oldValue : null;
    store.set(key, value);
    return opts?.get ? oldValue : "OK";
  });

  return {
    store,
    versionCalls,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set,
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

let fakeRedis = createScriptedRedis([1]);

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
  withRedisConfigured();
});
afterEach(() => {
  withoutRedisConfigured();
});

interface Fixture {
  restaurantId: string;
  locationId: string;
  itemId: string;
}

function ctx(f: Fixture): AuthContext {
  return { userId: "u1", employeeId: "e1", restaurantId: f.restaurantId, locationIds: [f.locationId], roles: ["WAITER"], permissions: new Set(["menu.view"]) };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "T", slug: `t-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "R", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Loc" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Hrana", slug: `hrana-${randomUUID()}`, type: "FOOD", sortOrder: 0 } });
  const item = await prisma.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, price: 500, isActive: true } });
  return { restaurantId: restaurant.id, locationId: location.id, itemId: item.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("P0.2b race fix: stable version", () => {
  it("before=5, after=5 -> snapshot returned with version 5, exactly one attempt", async () => {
    const f = await createFixture();
    fakeRedis = createScriptedRedis([5, 5]);

    const snapshot = await menu.getWaiterMenuSnapshot(ctx(f), f.locationId);

    expect(snapshot.menuVersion).toBe(5);
    expect(fakeRedis.versionCalls).toEqual([5, 5]); // exactly one attempt: before + after, no retry
  });
});

describe("P0.2b race fix: mutation during snapshot construction", () => {
  it("before=5, after=6 -> the mismatched attempt's version (6) is NEVER returned", async () => {
    const f = await createFixture();
    // Attempt 1 mismatches (5 -> 6); attempt 2 stabilizes (8 -> 8).
    fakeRedis = createScriptedRedis([5, 6, 8, 8]);

    const snapshot = await menu.getWaiterMenuSnapshot(ctx(f), f.locationId);

    expect(snapshot.menuVersion).not.toBe(6);
    expect(snapshot.menuVersion).toBe(8);
  });

  it("a detected mismatch causes the retry to use fresh (authoritative) reads, never the same stale cache entry", async () => {
    const f = await createFixture();
    const c = ctx(f);

    // Seed the Redis item cache with STALE data (as if written before an
    // admin edit that this test is about to simulate).
    await menu.listMenuItems(c, { activeOnly: true }); // warms cache with "Pljeskavica"
    await prisma.menuItem.update({ where: { id: f.itemId }, data: { name: "Pljeskavica NOVO" } }); // DB changes, cache NOT invalidated (simulates the partial-failure scenario)

    // Attempt 1 mismatches (10 -> 11, "a mutation happened during the read");
    // attempt 2 stabilizes (12 -> 12).
    fakeRedis = createScriptedRedis([10, 11, 12, 12]);

    const snapshot = await menu.getWaiterMenuSnapshot(c, f.locationId);

    expect(snapshot.menuVersion).toBe(12);
    // The retry MUST have bypassed the stale cache and read the true,
    // current Postgres state — never the pre-seeded stale name.
    expect(snapshot.items.find((i) => i.id === f.itemId)?.name).toBe("Pljeskavica NOVO");
  });

  it("stable retry: first attempt 5->6 (mismatch), second attempt 6->6 (stable) -> fresh snapshot returned as version 6", async () => {
    const f = await createFixture();
    fakeRedis = createScriptedRedis([5, 6, 6, 6]);

    const snapshot = await menu.getWaiterMenuSnapshot(ctx(f), f.locationId);

    expect(snapshot.menuVersion).toBe(6);
    expect(fakeRedis.versionCalls).toEqual([5, 6, 6, 6]); // exactly 2 attempts, 4 version reads total
  });
});

describe("P0.2b race fix: Redis-null at either boundary", () => {
  it("Redis unknown BEFORE the snapshot read -> snapshot still succeeds, menuVersion:null", async () => {
    const f = await createFixture();
    fakeRedis = createScriptedRedis(["error", 5]);

    const snapshot = await menu.getWaiterMenuSnapshot(ctx(f), f.locationId);

    expect(snapshot.menuVersion).toBeNull();
    expect(snapshot.items.find((i) => i.id === f.itemId)?.name).toBe("Pljeskavica"); // data still authoritative
  });

  it("Redis becomes unavailable AFTER the snapshot read -> snapshot still succeeds, menuVersion:null", async () => {
    const f = await createFixture();
    fakeRedis = createScriptedRedis([5, "error"]);

    const snapshot = await menu.getWaiterMenuSnapshot(ctx(f), f.locationId);

    expect(snapshot.menuVersion).toBeNull();
    expect(snapshot.items.find((i) => i.id === f.itemId)?.name).toBe("Pljeskavica");
  });
});

describe("P0.2b race fix: bounded retry, no infinite loop", () => {
  it("continuously changing versions never loop forever, and never falsely claim a numeric version", async () => {
    const f = await createFixture();
    // Every single read returns a different number — NEVER stable.
    fakeRedis = createScriptedRedis([1, 2, 3, 4, 5, 6, 7, 8]);

    const started = Date.now();
    const snapshot = await menu.getWaiterMenuSnapshot(ctx(f), f.locationId);
    const elapsedMs = Date.now() - started;

    expect(snapshot.menuVersion).toBeNull(); // never a fabricated number
    expect(elapsedMs).toBeLessThan(5000); // returned promptly, did not hang
    // Exactly MAX_SNAPSHOT_ATTEMPTS (2) attempts worth of version reads (4),
    // never more — proves the bound is real, not just "eventually gives up".
    expect(fakeRedis.versionCalls.length).toBe(4);
  });
});
