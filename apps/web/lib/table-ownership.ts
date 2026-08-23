/**
 * Hitna ispravka — čista logika izvučena iz pos-client.tsx da bi bila
 * unit-testabilna bez DOM-a (isti obrazac kao lib/pwa.ts, lib/order-cart.ts).
 *
 * Vlasništvo se proverava PRE navigacije (specifikacija: "Ownership must be
 * detected BEFORE navigation") — server (getOwnedDraftOrder) ostaje krajnji
 * autoritet, ovo je SAMO UX da konobar ne uđe na skoro prazan ekran tuđe
 * porudžbine.
 */
export function isTableHeldByAnotherWaiter(
  activeOrderOwnerId: string | null,
  currentEmployeeId: string | null
): boolean {
  return activeOrderOwnerId !== null && activeOrderOwnerId !== currentEmployeeId;
}
