/**
 * Bezbedno-degradiranje cache sloja (packages/domain/cache/cache-client.ts).
 * Redis se mokuje u potpunosti — ovi testovi NIKAD ne otvaraju pravu mrežnu
 * konekciju, isti princip kao i ostatak tests/unit (čista logika, bez baze).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDel = vi.fn();
const mockIncr = vi.fn();

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn().mockImplementation(() => ({ get: mockGet, set: mockSet, del: mockDel, incr: mockIncr })),
}));

const ENV_URL = "UPSTASH_REDIS_REST_URL";
const ENV_TOKEN = "UPSTASH_REDIS_REST_TOKEN";

function withRedisConfigured() {
  process.env[ENV_URL] = "https://example.upstash.io";
  process.env[ENV_TOKEN] = "test-token";
}

function withoutRedisConfigured() {
  delete process.env[ENV_URL];
  delete process.env[ENV_TOKEN];
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}

beforeEach(() => {
  vi.clearAllMocks();
  withoutRedisConfigured();
});

afterEach(() => {
  withoutRedisConfigured();
});

describe("buildCacheKey — tenant-safe key isolation", () => {
  it("scopes keys by restaurantId so two restaurants never collide", async () => {
    const { buildCacheKey } = await import("../../packages/domain/cache/cache-client");
    const keyA = buildCacheKey("restaurant-A", "menu-items", "active");
    const keyB = buildCacheKey("restaurant-B", "menu-items", "active");
    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain("restaurant-A");
    expect(keyB).toContain("restaurant-B");
  });

  it("produces distinct keys for distinct resource parts under the same restaurant", async () => {
    const { buildCacheKey } = await import("../../packages/domain/cache/cache-client");
    const categories = buildCacheKey("r1", "categories");
    const settings = buildCacheKey("r1", "settings");
    expect(categories).not.toBe(settings);
  });
});

describe("getOrSet — no Redis configured (development / credentials absent)", () => {
  it("always calls the loader and never throws when UPSTASH env vars are missing", async () => {
    const { getOrSet } = await import("../../packages/domain/cache/cache-client");
    const loader = vi.fn().mockResolvedValue({ ok: true });
    const result = await getOrSet({ key: "k", ttlSeconds: 60, loader });
    expect(result).toEqual({ ok: true });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("getOrSet — cache hit", () => {
  it("returns the cached value and never calls the loader", async () => {
    withRedisConfigured();
    mockGet.mockResolvedValue({ cached: true });
    const { getOrSet } = await import("../../packages/domain/cache/cache-client");
    const loader = vi.fn().mockResolvedValue({ cached: false });

    const result = await getOrSet({ key: "menu:cat", ttlSeconds: 300, loader });

    expect(result).toEqual({ cached: true });
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("getOrSet — cache miss", () => {
  it("calls the loader and stores the result with the given TTL", async () => {
    withRedisConfigured();
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue("OK");
    const { getOrSet } = await import("../../packages/domain/cache/cache-client");
    const loader = vi.fn().mockResolvedValue({ fresh: true });

    const result = await getOrSet({ key: "menu:cat", ttlSeconds: 300, loader });

    expect(result).toEqual({ fresh: true });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith("menu:cat", { fresh: true }, { ex: 300 });
  });
});

describe("invalidation", () => {
  it("cacheDel removes the key so a subsequent getOrSet recomputes from the loader", async () => {
    withRedisConfigured();
    const { getOrSet, cacheDel } = await import("../../packages/domain/cache/cache-client");

    mockGet.mockResolvedValueOnce({ version: 1 });
    const first = await getOrSet({ key: "settings:r1", ttlSeconds: 300, loader: async () => ({ version: 1 }) });
    expect(first).toEqual({ version: 1 });

    await cacheDel("settings:r1");
    expect(mockDel).toHaveBeenCalledWith("settings:r1");

    mockGet.mockResolvedValueOnce(null); // simulates the real backing store no longer having the key
    const loader2 = vi.fn().mockResolvedValue({ version: 2 });
    const second = await getOrSet({ key: "settings:r1", ttlSeconds: 300, loader: loader2 });
    expect(second).toEqual({ version: 2 });
    expect(loader2).toHaveBeenCalledTimes(1);
  });

  it("cacheDel is a safe no-op when Redis is not configured", async () => {
    const { cacheDel } = await import("../../packages/domain/cache/cache-client");
    await expect(cacheDel("some:key")).resolves.toBeUndefined();
    expect(mockDel).not.toHaveBeenCalled();
  });
});

describe("cacheIncr — P0.2a atomic increment primitive", () => {
  it("is a safe no-op (returns null) when Redis is not configured", async () => {
    const { cacheIncr } = await import("../../packages/domain/cache/cache-client");
    await expect(cacheIncr("some:counter")).resolves.toBeNull();
    expect(mockIncr).not.toHaveBeenCalled();
  });

  it("delegates to redis.incr() — never synthesizes the increment via get+set", async () => {
    withRedisConfigured();
    mockIncr.mockResolvedValue(1);
    const { cacheIncr } = await import("../../packages/domain/cache/cache-client");

    const result = await cacheIncr("tablecore:restaurant:r1:menu-version");

    expect(result).toBe(1);
    expect(mockIncr).toHaveBeenCalledWith("tablecore:restaurant:r1:menu-version");
    // Ključni dokaz atomarnosti: implementacija NIKAD ne čita pa piše nazad
    // (što bi otvorilo trku između dva konkurentna admin uređivanja) — samo
    // deleguje na Redis-ov sopstveni atomarni INCR.
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when redis.incr() fails, and does not otherwise misbehave", async () => {
    withRedisConfigured();
    mockIncr.mockRejectedValue(new Error("Upstash timeout"));
    const { cacheIncr } = await import("../../packages/domain/cache/cache-client");

    await expect(cacheIncr("k")).resolves.toBeNull();
  });
});

describe("cacheEnsureCounter — P0.2a correction: distinguishes 'newly initialized' from 'already existed' from 'unknown'", () => {
  it("is a safe no-op (returns null) when Redis is not configured", async () => {
    const { cacheEnsureCounter } = await import("../../packages/domain/cache/cache-client");
    await expect(cacheEnsureCounter("counter", 1)).resolves.toBeNull();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("calls SET key initialValue with { nx: true, get: true } — never a plain get-then-set", async () => {
    withRedisConfigured();
    mockSet.mockResolvedValue(null); // simulira: ključ nije postojao
    const { cacheEnsureCounter } = await import("../../packages/domain/cache/cache-client");

    const result = await cacheEnsureCounter("tablecore:restaurant:r1:menu-version", 1);

    expect(result).toBe(1);
    expect(mockSet).toHaveBeenCalledWith("tablecore:restaurant:r1:menu-version", 1, { nx: true, get: true });
    expect(mockGet).not.toHaveBeenCalled(); // nema odvojenog čitanja pre pisanja — jedan atomaran poziv
  });

  it("returns the EXISTING value, unchanged, when the key already exists (SET...GET returns the old value)", async () => {
    withRedisConfigured();
    mockSet.mockResolvedValue(7); // simulira: ključ je već postojao sa vrednošću 7
    const { cacheEnsureCounter } = await import("../../packages/domain/cache/cache-client");

    const result = await cacheEnsureCounter("tablecore:restaurant:r1:menu-version", 1);

    expect(result).toBe(7); // NIKAD resetovano na 1
  });

  it("returns null (never throws, never a fabricated number) when redis.set() fails", async () => {
    withRedisConfigured();
    mockSet.mockRejectedValue(new Error("Upstash timeout"));
    const { cacheEnsureCounter } = await import("../../packages/domain/cache/cache-client");

    await expect(cacheEnsureCounter("k", 1)).resolves.toBeNull();
  });

  it("defensively returns null (never a wrong-typed value) if the reply is not a number or null", async () => {
    withRedisConfigured();
    mockSet.mockResolvedValue("OK"); // tip komande dozvoljava "OK" iako se u praksi ne dešava sa get:true
    const { cacheEnsureCounter } = await import("../../packages/domain/cache/cache-client");

    await expect(cacheEnsureCounter("k", 1)).resolves.toBeNull();
  });
});

describe("Redis unavailable — graceful fallback to PostgreSQL", () => {
  it("falls back to the loader when redis.get() throws", async () => {
    withRedisConfigured();
    mockGet.mockRejectedValue(new Error("ECONNREFUSED"));
    const { getOrSet } = await import("../../packages/domain/cache/cache-client");
    const loader = vi.fn().mockResolvedValue({ fromDb: true });

    const result = await getOrSet({ key: "menu:cat", ttlSeconds: 300, loader });

    expect(result).toEqual({ fromDb: true });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("still returns the loader result when redis.set() throws after a miss", async () => {
    withRedisConfigured();
    mockGet.mockResolvedValue(null);
    mockSet.mockRejectedValue(new Error("Upstash unavailable"));
    const { getOrSet } = await import("../../packages/domain/cache/cache-client");

    const result = await getOrSet({ key: "menu:cat", ttlSeconds: 300, loader: async () => ({ ok: true }) });

    expect(result).toEqual({ ok: true });
  });

  it("never throws out of cacheGet/cacheSet/cacheDel even when Redis errors on every call", async () => {
    withRedisConfigured();
    mockGet.mockRejectedValue(new Error("timeout"));
    mockSet.mockRejectedValue(new Error("timeout"));
    mockDel.mockRejectedValue(new Error("timeout"));
    const { cacheGet, cacheSet, cacheDel } = await import("../../packages/domain/cache/cache-client");

    await expect(cacheGet("k")).resolves.toBeNull();
    await expect(cacheSet("k", { a: 1 }, 60)).resolves.toBeUndefined();
    await expect(cacheDel("k")).resolves.toBeUndefined();
  });
});
