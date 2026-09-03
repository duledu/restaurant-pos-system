/**
 * Čista logika za pretragu/filtriranje menija u konobarskoj korpi, izvučena
 * iz order-client.tsx da bi bila unit-testabilna bez DOM-a (isti razlog kao
 * lib/order-cart.ts). Kad je pretraga aktivna, traži se PREKO CELOG menija
 * (svih kategorija) — konobar ne treba ručno da menja karticu kategorije da
 * bi pronašao artikal koji zna po imenu (VIŠE-KRUŽNO NARUČIVANJE audit:
 * "Dodatna porudžbina" mora naći isti artikal kao prvi krug).
 */

export interface SearchableMenuItem {
  name: string;
  categoryId: string | null;
}

/** Case/dijakritik-neosetljivo poklapanje po imenu — "Vinjak"/"vinjak"/"VINJAK" su isti upit. */
export function matchesMenuSearch(item: SearchableMenuItem, query: string): boolean {
  return item.name.toLowerCase().includes(query.trim().toLowerCase());
}

export function filterMenuItems<T extends SearchableMenuItem>(
  items: T[],
  search: string,
  activeCategoryId: string | null
): T[] {
  const query = search.trim();
  if (query) return items.filter((item) => matchesMenuSearch(item, query));
  return items.filter((item) => item.categoryId === activeCategoryId);
}
