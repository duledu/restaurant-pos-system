import { describe, expect, it, vi } from "vitest";
import { MENU_MAX_AGE_MS, refreshWaiterMenu } from "../../apps/web/lib/waiter-menu-refresh";

const item = { id: "a", name: "Coffee", price: "200", categoryId: "c", modifierGroups: [] };
const current = { restaurantId: "r", locationId: "l", menuVersion: 1, categories: [{ id: "c", name: "Drinks", type: "DRINK" as const }], items: [item], availabilityByItemId: new Map(), promotions: [], restaurantTimezone: "Europe/Madrid" };
function overlay(ids = ["a"]) { return { locationId: "l", items: ids.map(menuItemId => ({ menuItemId, stock: null, recipeAvailability: null, availability: { isAvailable: true } })) }; }
function fixture(version: number | null = 1, snapshot = current, availability = overlay()) {
  return vi.fn(async (url: string) => {
    if (url.includes("/version")) return { version };
    if (url.includes("/snapshot")) return snapshot;
    return availability;
  });
}

describe("prepared menu reconciliation", () => {
  it("keeps the loaded catalog and makes only version/availability requests when unchanged", async () => {
    const fetch = fixture();
    const result = await refreshWaiterMenu(current, 100, fetch, 200);
    expect(result.menu.items).toBe(current.items);
    expect(result.menu.categories).toBe(current.categories);
    expect(result.snapshotAt).toBe(100);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("atomically replaces changed products, prices, categories, modifiers and removed IDs", async () => {
    const next = { ...current, menuVersion: 2, categories: [], items: [{ ...item, id: "b", price: "300", modifierGroups: [] }] };
    const fetch = fixture(2, next, overlay(["b"]));
    const result = await refreshWaiterMenu(current, 100, fetch, 200);
    expect(result.menu.items).toEqual(next.items);
    expect(result.menu.categories).toEqual([]);
    expect([...result.menu.availabilityByItemId.keys()]).toEqual(["b"]);
    expect(current.items).toEqual([item]);
    expect(fetch.mock.calls.some(([url]) => url.endsWith("&fresh=1"))).toBe(true);
  });
  it.each([null, 2])("refreshes an unknown/changed server version %s", async version => {
    const fetch = fixture(version);
    await refreshWaiterMenu(current, 100, fetch, 200);
    expect(fetch.mock.calls.filter(([url]) => url.includes("/snapshot"))).toHaveLength(1);
  });
  it("bounds cache age even if the version counter was reset", async () => {
    const fetch = fixture();
    await refreshWaiterMenu(current, 100, fetch, 100 + MENU_MAX_AGE_MS);
    expect(fetch.mock.calls.filter(([url]) => url.includes("/snapshot"))).toHaveLength(1);
  });
  it("reconciles extra or removed availability IDs even when the version did not advance", async () => {
    const next = { ...current, items: [] };
    const result = await refreshWaiterMenu(current, 100, fixture(1, next, overlay([])), 200);
    expect(result.menu.items).toEqual([]);
    expect(result.menu.availabilityByItemId.size).toBe(0);
  });
  it("retries a snapshot/availability race once before publishing", async () => {
    let snapshots = 0;
    const fetch = vi.fn(async (url: string) => url.includes("/version") ? { version: 2 }
      : url.includes("/snapshot") ? { ...current, items: ++snapshots === 1 ? [item] : [] }
      : overlay([]));
    const result = await refreshWaiterMenu(current, 100, fetch, 200);
    expect(snapshots).toBe(2);
    expect(result.menu.items).toEqual([]);
  });
  it("rejects a persistently incomplete pair and leaves the old catalog untouched", async () => {
    const fetch = fixture(2, current, overlay([]));
    await expect(refreshWaiterMenu(current, 100, fetch, 200)).rejects.toThrow();
    expect(fetch.mock.calls.filter(([url]) => url.includes("/snapshot"))).toHaveLength(2);
    expect(current.items).toEqual([item]);
  });
  it.each([{ restaurantId: "other" }, { locationId: "other" }])("rejects a snapshot for a different scope %s", async mismatch => {
    await expect(refreshWaiterMenu(current, 100, fixture(2, { ...current, ...mismatch }), 200)).rejects.toThrow();
  });
  it("rejects an availability response for another location", async () => {
    await expect(refreshWaiterMenu(current, 100, fixture(2, current, { ...overlay(), locationId: "other" }), 200)).rejects.toThrow();
  });
  it("propagates network failure without mutating cached data", async () => {
    await expect(refreshWaiterMenu(current, 100, async () => { throw new Error("network"); }, 200)).rejects.toThrow("network");
    expect(current.items).toEqual([item]);
  });
  it("removes stale modifier groups and options from a retained product", async () => {
    const group = { id: "g", name: "Extras", required: false, minSelect: 0, maxSelect: 1, isActive: true, options: [{ id: "milk", name: "Milk", priceDelta: "20", isActive: true }] };
    const withModifiers = { ...current, items: [{ ...item, modifierGroups: [{ group }] }] };
    const result = await refreshWaiterMenu(withModifiers, 100, fixture(2, { ...current, menuVersion: 2 }), 200);
    expect(result.menu.items[0].modifierGroups).toEqual([]);
    expect(withModifiers.items[0].modifierGroups[0].group.options).toHaveLength(1);
  });
});
