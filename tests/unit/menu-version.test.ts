/**
 * P0.2a — getMenuVersion/bumpMenuVersion (packages/domain/menu/menu-service.ts).
 * Čista Redis logika, Upstash mock-ovan isto kao tests/unit/cache-client.test.ts
 * — NIKAD ne dodiruje pravu bazu (menu-service.ts uvozi @rcs/db, ali ove dve
 * funkcije nikad ne pozivaju prisma, pa je import bezbedan bez DATABASE_URL).
 *
 * P0.2a KOREKCIJA: 0 se VIŠE NE koristi ni za "ključ nikad nije postojao"
 * ni za "Redis nedostupan" — getMenuVersion sada ATOMARNO OBEZBEĐUJE da
 * ključ postoji (inicijalizuje na 1 ako nedostaje) i vraća `null` (NIKAD
 * broj) isključivo kad je Redis nedostupan/greška.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SetOptions {
  nx?: boolean;
  get?: boolean;
  ex?: number;
}

/** Realan (ne samo spy) in-memory Redis dvojnik — ISPRAVNO implementira
 * SET key val NX GET semantiku (ključna za cacheEnsureCounter):
 *  - ključ postoji: NX blokira upis, GET vraća STARU (nepromenjenu)
 *    vrednost.
 *  - ključ ne postoji: NX dozvoljava upis, GET vraća null (nije bilo
 *    stare vrednosti) — ali NOVA vrednost je sada upisana.
 * Bez ovoga bi mock uvek vraćao "OK" i cacheEnsureCounter bi (ispravno,
 * defanzivno) tretirao svaki poziv kao grešku — testovi bi lažno "prošli"
 * dokazujući pogrešnu stvar. */
function createFakeRedis() {
  const store = new Map<string, number>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: number, opts?: SetOptions) => {
      const hadKey = store.has(key);
      const oldValue = hadKey ? (store.get(key) ?? null) : null;
      if (opts?.nx && hadKey) {
        return opts?.get ? oldValue : null; // NX odbija upis — ključ ostaje nepromenjen
      }
      store.set(key, value);
      return opts?.get ? oldValue : "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    }),
    // Redis INCR: nedostajući ključ počinje od 0, pa se inkrementira — JEDNA
    // sinhrona operacija bez ijednog `await` između čitanja i pisanja, tačno
    // ono što realan Redis garantuje na serverskoj strani.
    incr: vi.fn(async (key: string) => {
      const next = (store.get(key) ?? 0) + 1;
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
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}

beforeEach(() => {
  fakeRedis = createFakeRedis();
  withoutRedisConfigured();
});
afterEach(() => {
  withoutRedisConfigured();
});

describe("getMenuVersion: corrected initial/missing-key semantics (P0.2a fix)", () => {
  it("a missing key is atomically initialized to 1, and 1 is returned", async () => {
    withRedisConfigured();
    const { getMenuVersion } = await import("../../packages/domain/menu/menu-service");
    await expect(getMenuVersion("r1")).resolves.toBe(1);
  });

  it("the initialized value remains 1 across repeated reads (never reset, never re-randomized)", async () => {
    withRedisConfigured();
    const { getMenuVersion } = await import("../../packages/domain/menu/menu-service");
    await expect(getMenuVersion("r1")).resolves.toBe(1);
    await expect(getMenuVersion("r1")).resolves.toBe(1);
    await expect(getMenuVersion("r1")).resolves.toBe(1);
  });

  it("returns explicit null (NEVER 0, NEVER a number) when Redis is not configured at all", async () => {
    const { getMenuVersion } = await import("../../packages/domain/menu/menu-service");
    await expect(getMenuVersion("r1")).resolves.toBeNull();
  });

  it("an existing (already-bumped) value is never reset by a later getMenuVersion call", async () => {
    withRedisConfigured();
    const { getMenuVersion, bumpMenuVersion } = await import("../../packages/domain/menu/menu-service");
    await bumpMenuVersion("r1"); // key doesn't exist yet -> INCR creates it at 1
    await bumpMenuVersion("r1"); // -> 2
    await expect(getMenuVersion("r1")).resolves.toBe(2); // ensure() must NOT reset this back to 1
    await expect(getMenuVersion("r1")).resolves.toBe(2);
  });
});

describe("bumpMenuVersion: monotonic increase (unchanged from P0.2a)", () => {
  it("first bump after initialization produces 2", async () => {
    withRedisConfigured();
    const { getMenuVersion, bumpMenuVersion } = await import("../../packages/domain/menu/menu-service");
    await expect(getMenuVersion("r1")).resolves.toBe(1); // establishes baseline
    await bumpMenuVersion("r1");
    await expect(getMenuVersion("r1")).resolves.toBe(2);
  });

  it("two bumps produce a monotonically higher version (3, not reset, not skipped)", async () => {
    withRedisConfigured();
    const { getMenuVersion, bumpMenuVersion } = await import("../../packages/domain/menu/menu-service");
    await getMenuVersion("r1"); // -> 1
    await bumpMenuVersion("r1"); // -> 2
    await bumpMenuVersion("r1"); // -> 3
    await expect(getMenuVersion("r1")).resolves.toBe(3);
  });

  it("bumpMenuVersion never throws when Redis is unavailable — mutation callers must never fail because of this", async () => {
    const { bumpMenuVersion } = await import("../../packages/domain/menu/menu-service");
    await expect(bumpMenuVersion("r1")).resolves.toBeUndefined();
  });

  it("Redis read/write failure never breaks a menu mutation — getMenuVersion and bumpMenuVersion both degrade safely on redis errors", async () => {
    withRedisConfigured();
    fakeRedis.set.mockRejectedValueOnce(new Error("Upstash timeout"));
    fakeRedis.incr.mockRejectedValueOnce(new Error("Upstash timeout"));
    const { getMenuVersion, bumpMenuVersion } = await import("../../packages/domain/menu/menu-service");

    await expect(getMenuVersion("r1")).resolves.toBeNull();
    await expect(bumpMenuVersion("r1")).resolves.toBeUndefined();
  });
});

describe("menu version: restaurant isolation (unchanged)", () => {
  it("bumping restaurant A's version does not affect restaurant B's", async () => {
    withRedisConfigured();
    const { getMenuVersion, bumpMenuVersion } = await import("../../packages/domain/menu/menu-service");
    await getMenuVersion("restaurant-A"); // -> 1
    await bumpMenuVersion("restaurant-A"); // -> 2
    await expect(getMenuVersion("restaurant-A")).resolves.toBe(2);
    await expect(getMenuVersion("restaurant-B")).resolves.toBe(1); // fresh restaurant, own baseline
  });
});

describe("menu version: concurrency", () => {
  it("20 concurrent bumps for the same restaurant produce exactly 20 distinct, non-colliding increments", async () => {
    withRedisConfigured();
    const { getMenuVersion, bumpMenuVersion } = await import("../../packages/domain/menu/menu-service");

    await Promise.all(Array.from({ length: 20 }, () => bumpMenuVersion("r1")));

    await expect(getMenuVersion("r1")).resolves.toBe(20);
    // Dokaz da je stvarno Redis INCR primitiv u pitanju, ne read-then-write
    // na nivou menu-service.ts (koji bi pod konkurentnošću izgubio
    // inkremente) — vidi cache-client.test.ts za direktan dokaz na tom nivou.
    expect(fakeRedis.incr).toHaveBeenCalledTimes(20);
  });

  it("concurrent getMenuVersion (ensure) calls on a fresh key result in exactly one stable initialized value", async () => {
    withRedisConfigured();
    const { getMenuVersion } = await import("../../packages/domain/menu/menu-service");

    const results = await Promise.all(Array.from({ length: 10 }, () => getMenuVersion("r1")));

    // SVI konkurentni pozivi moraju videti ISTU, stabilnu vrednost — nijedan
    // ne sme "pobediti" sa drugačijim brojem, i nijedan ne sme videti null.
    expect(results.every((v) => v === 1)).toBe(true);
  });
});
