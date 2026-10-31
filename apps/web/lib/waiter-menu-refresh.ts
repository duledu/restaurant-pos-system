import { readAvailability, readMenuSnapshot } from "./waiter-menu";
import type { PreparationResult } from "./waiter-shift-preparation";

type MenuState = Pick<PreparationResult, "restaurantId" | "locationId" | "items" | "categories" | "menuVersion" | "availabilityByItemId" | "promotions" | "restaurantTimezone">;
type FetchJson = (url: string) => Promise<any>;
// A bounded authoritative refresh also recovers from a lost/reset Redis counter.
export const MENU_MAX_AGE_MS = 300_000;

export async function refreshWaiterMenu(current: MenuState, snapshotAt: number, fetchJson: FetchJson, now = Date.now()) {
  const query = `locationId=${encodeURIComponent(current.locationId)}`;
  const requests = [
    fetchJson(`/api/pos/menu/version?${query}`),
    fetchJson(`/api/pos/menu/availability?${query}`),
  ];
  // Drain both requests on failure so a retry cannot overlap the old overlay.
  await Promise.allSettled(requests);
  const [version, availability] = await Promise.all(requests);
  if ((version.restaurantId !== undefined && version.restaurantId !== current.restaurantId)
    || (version.locationId !== undefined && version.locationId !== current.locationId)) throw new Error("Identitet menija nije usklađen");

  let snapshot = current;
  let overlay = availability;
  let fullRefresh = current.menuVersion === null || version.version !== current.menuVersion || now - snapshotAt >= MENU_MAX_AGE_MS;
  if (!fullRefresh) {
    try { readAvailability(overlay, current.locationId, current.items); }
    catch { fullRefresh = true; }
  }
  if (fullRefresh) {
    // Retry a catalog/overlay membership race once. Never publish a partial pair.
    for (let attempt = 0; ; attempt++) {
      const fresh = await fetchJson(`/api/pos/menu/snapshot?${query}&fresh=1`);
      const validated = readMenuSnapshot(fresh, current.restaurantId, current.locationId);
      snapshot = { ...current, ...validated };
      overlay = await fetchJson(`/api/pos/menu/availability?${query}`);
      try { readAvailability(overlay, current.locationId, snapshot.items); break; }
      catch (error) { if (attempt === 1) throw error; }
    }
  }
  if (overlay.restaurantId !== undefined && overlay.restaurantId !== current.restaurantId) throw new Error("Identitet dostupnosti nije usklađen");
  return {
    menu: { ...snapshot,
      availabilityByItemId: readAvailability(overlay, current.locationId, snapshot.items),
      promotions: Array.isArray(overlay.promotions) ? overlay.promotions : current.promotions,
      restaurantTimezone: overlay.restaurantTimezone ?? current.restaurantTimezone,
    } satisfies MenuState,
    snapshotAt: fullRefresh ? now : snapshotAt,
  };
}
