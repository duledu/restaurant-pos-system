/**
 * Čista logika za SPREMNO obaveštenje konobaru (Faza 10), izvučena iz
 * pos-client.tsx da bi bila unit-testabilna bez DOM-a (isti razlog kao
 * lib/order-cart.ts, lib/menu-search.ts).
 */

export interface TableLike {
  activeOrderOwnerId: string | null;
  readyItems: { id: string }[];
}

/** Skup id-jeva SPREMNIH stavki na stolovima čiji je odgovorni konobar
 * `employeeId` — "ne obaveštavaj nepovezane konobare" polazi odavde: samo
 * OVAJ skup ikad izaziva zvuk/pulsiranje kod POZIVAOCA ove funkcije. */
export function myReadyItemIds(tables: TableLike[], employeeId: string | null): Set<string> {
  const ids = new Set<string>();
  if (!employeeId) return ids;
  for (const table of tables) {
    if (table.activeOrderOwnerId === employeeId) {
      for (const item of table.readyItems) ids.add(item.id);
    }
  }
  return ids;
}

/**
 * Da li `current` sadrži bar jedan id koji NIJE bio u `known` — jedini
 * ispravan uslov za "zvoni sada" (specifikacija: samo za GENUINSKI NOV
 * READY događaj, nikad ponovo za već poznat id, bez obzira koliko puta
 * poll vrati isti odgovor).
 */
export function hasNewReadyId(known: Set<string>, current: Set<string>): boolean {
  for (const id of current) {
    if (!known.has(id)) return true;
  }
  return false;
}
