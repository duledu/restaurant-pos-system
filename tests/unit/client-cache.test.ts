import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrFetch, invalidateClientCache, clearClientCache } from "../../apps/web/lib/client-cache";

beforeEach(() => {
  clearClientCache();
});

afterEach(() => {
  clearClientCache();
  vi.useRealTimers();
});

describe("getOrFetch — cache miss", () => {
  it("calls the fetcher on first use and stores the result", async () => {
    const fetcher = vi.fn().mockResolvedValue({ v: 1 });
    const result = await getOrFetch("k1", 1000, fetcher);
    expect(result).toEqual({ v: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent misses on the same key into a single fetcher call", async () => {
    let resolveFetch!: (v: { v: number }) => void;
    const fetcher = vi.fn(() => new Promise<{ v: number }>((resolve) => (resolveFetch = resolve)));

    const p1 = getOrFetch("k1", 1000, fetcher);
    const p2 = getOrFetch("k1", 1000, fetcher);
    resolveFetch({ v: 42 });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ v: 42 });
    expect(r2).toEqual({ v: 42 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("getOrFetch — cache hit", () => {
  it("returns the cached value without calling the fetcher again while fresh", async () => {
    const fetcher = vi.fn().mockResolvedValue({ v: 1 });
    await getOrFetch("k1", 60_000, fetcher);
    const second = await getOrFetch("k1", 60_000, fetcher);
    expect(second).toEqual({ v: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("getOrFetch — stale-while-revalidate", () => {
  it("serves the stale value immediately after TTL expiry and refreshes in the background", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce({ v: "first" }).mockResolvedValueOnce({ v: "second" });

    const first = await getOrFetch("k1", 1000, fetcher);
    expect(first).toEqual({ v: "first" });

    vi.advanceTimersByTime(1500); // past TTL

    const stale = await getOrFetch("k1", 1000, fetcher);
    expect(stale).toEqual({ v: "first" }); // still the old value, returned instantly
    expect(fetcher).toHaveBeenCalledTimes(2); // background refresh WAS triggered

    await vi.runAllTimersAsync(); // let the background refresh's promise settle
    const fresh = await getOrFetch("k1", 1000, fetcher);
    expect(fresh).toEqual({ v: "second" });
  });
});

describe("invalidation", () => {
  it("invalidateClientCache forces the next call to refetch", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ v: 1 }).mockResolvedValueOnce({ v: 2 });
    await getOrFetch("k1", 60_000, fetcher);
    invalidateClientCache("k1");
    const result = await getOrFetch("k1", 60_000, fetcher);
    expect(result).toEqual({ v: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("clearClientCache resets every key", async () => {
    await getOrFetch("a", 60_000, async () => "a-value");
    await getOrFetch("b", 60_000, async () => "b-value");
    clearClientCache();
    const fetcherA = vi.fn().mockResolvedValue("a-value-2");
    expect(await getOrFetch("a", 60_000, fetcherA)).toBe("a-value-2");
    expect(fetcherA).toHaveBeenCalledTimes(1);
  });
});

describe("key isolation between distinct resources", () => {
  it("different keys never share a cached value", async () => {
    await getOrFetch("me", 60_000, async () => ({ who: "employee-1" }));
    const categories = await getOrFetch("categories", 60_000, async () => ({ who: "categories" }));
    expect(categories).toEqual({ who: "categories" });
  });
});
