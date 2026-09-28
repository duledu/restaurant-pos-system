import type { PublicMenuCategory, PublicMenuItem } from "@rcs/domain/qrmenu/qr-menu-service";

export type MenuMode = "KITCHEN" | "BAR";

/** Use the stored station; NONE falls back to the existing category type. */
export function itemBelongsToMode(item: PublicMenuItem, category: PublicMenuCategory, mode: MenuMode) {
  if (item.preparationStation === "KITCHEN_AND_BAR") return true;
  if (item.preparationStation === "NONE") return mode === (category.type === "DRINK" ? "BAR" : "KITCHEN");
  return item.preparationStation === mode;
}

function normalizeSearch(value: string) {
  return value.toLocaleLowerCase("sr-Latn").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "dj");
}

export function filterPublicMenu(categories: PublicMenuCategory[], mode: MenuMode, search = "") {
  const query = normalizeSearch(search.trim());
  return categories.map(category => ({
    ...category,
    items: category.items.filter(item => itemBelongsToMode(item, category, mode) &&
      (!query || normalizeSearch(`${item.name} ${item.description ?? ""}`).includes(query))),
  })).filter(category => category.items.length > 0);
}

/** Browser-only sources. This never fetches, proxies, or rewrites remote URLs. */
export function publicImageSource(value: string | null): string | undefined {
  const source = value?.trim();
  if (!source) return undefined;
  if (/^\/(?!\/)/.test(source) || /^data:image\/(png|jpeg|webp|gif);base64,/i.test(source)) return source;
  try {
    const url = new URL(source);
    return ["https:", "http:"].includes(url.protocol) ? source : undefined;
  } catch { return undefined; }
}

/** An occasional photographed dish, after three compact rows, in source order. */
export function editorialItemId(category: PublicMenuCategory, categoryIndex: number) {
  if (categoryIndex % 3 !== 0 || category.items.filter(item => publicImageSource(item.imageUrl)).length < 3) return null;
  return category.items.find((item, index) => index >= 3 && item.isAvailable && publicImageSource(item.imageUrl))?.id ?? null;
}
