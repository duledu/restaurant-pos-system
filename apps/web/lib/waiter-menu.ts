export interface Category {
  id: string;
  name: string;
  type: "FOOD" | "DRINK";
}

export interface ModifierOption {
  id: string;
  name: string;
  priceDelta: string;
  isActive: boolean;
}
export interface ModifierGroup {
  id: string;
  name: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  isActive: boolean;
  options: ModifierOption[];
}
export interface MenuItemStock {
  trackingEnabled: boolean;
  currentStock: string | null;
  minimumStock: string | null;
  stockStatus: "NEGATIVE" | "OUT" | "LOW" | "OK" | null;
}
export interface RecipeAvailability {
  status: "NEGATIVE" | "AVAILABLE" | "LOW" | "OUT";
  availablePortions: number;
  limitingIngredientName: string | null;
  // P1.6: false = artikal je u RECIPE modu ali nema definisan normativ
  // ("Normativ nije podešen") — odvojeno od običnog "nema dovoljno sirovina".
  configured: boolean;
  // P1.7: true iff configured — negativna/nedovoljna zaliha više NE
  // sprečava prodaju, samo prikazuje savetodavno upozorenje.
  sellAllowed: boolean;
}
export interface MenuItem {
  id: string;
  // Existing authoritative menu/KDS route. Missing legacy data is not guessed.
  preparationStation?: "KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE";
  name: string;
  price: string;
  categoryId: string | null;
  // Sirovi Prisma include oblik (MenuItemModifierGroup join) — vidi
  // menu-service.ts listMenuItems. Prazan niz za artikle bez dodataka.
  modifierGroups: { group: ModifierGroup }[];
  // P3.3: prisutno SAMO kad je meni zatražen sa locationId (vidi load()
  // ispod) — null dok se ne učita, nikad se ne tumači kao OUT.
  stock: MenuItemStock | null;
  // P1.4: recepturisan (sirovinski) artikal — prisutno SAMO za artikle sa
  // konfigurisanim normativom, isto "null = ne primenjuje se" pravilo kao
  // stock. Nikad oba polja istovremeno smisleno "aktivna" (recepturisan
  // artikal ima trackStock isključen — vidi inventory-service.ts double-
  // deduction odbranu), ali oba se čitaju nezavisno radi jasnoće.
  recipeAvailability: RecipeAvailability | null;
  // Operativna (Kuhinja/Šank "NIJE DOSTUPNO") dostupnost — POTPUNO nezavisno
  // od stock/recipeAvailability iznad (nikad null, uvek prisutno kad je
  // meni zatražen sa locationId — vidi availability-service.ts).
  availability: { isAvailable: boolean; reasonCode: string | null; reasonLabel: string | null } | null;
}

export type StaticMenuItem = Omit<MenuItem, "stock" | "recipeAvailability" | "availability">;
export type LiveAvailability = Pick<MenuItem, "stock" | "recipeAvailability" | "availability">;

/** The endpoint is a full snapshot, never a delta. Reject incomplete responses. */
export function readAvailability(body: unknown, locationId: string, items: readonly { id: string }[]): Map<string, LiveAvailability> {
  const response = body as { locationId?: string; items?: Array<LiveAvailability & { menuItemId: string }> } | null;
  if (response?.locationId !== locationId || !Array.isArray(response.items)) throw new Error("Dostupnost nije usklađena");
  const result = new Map<string, LiveAvailability>();
  for (const row of response.items) {
    if (!row || typeof row.menuItemId !== "string" || result.has(row.menuItemId)
      || typeof row.availability?.isAvailable !== "boolean"
      || row.stock === undefined || row.recipeAvailability === undefined
      || (row.recipeAvailability !== null && typeof row.recipeAvailability.configured !== "boolean")) {
      throw new Error("Dostupnost nije potpuna");
    }
    result.set(row.menuItemId, { stock: row.stock, recipeAvailability: row.recipeAvailability, availability: row.availability });
  }
  if (items.some(item => !result.has(item.id))) throw new Error("Dostupnost nije potpuna");
  return result;
}

export type MenuSection = "KITCHEN" | "BAR";

/**
 * Main-menu KUHINJA/ŠANK grouping — presentation/navigation only, never
 * production routing (see production/station-state.ts stationsForPreparation
 * for the actual KDS split, unchanged and untouched by this). Unlike the
 * Quick Actions single-bucket display rule, a KITCHEN_AND_BAR item belongs
 * to BOTH sections here — the waiter must be able to find it regardless of
 * which section is open, and it is still exactly one MenuItem/OrderItem.
 * NONE (or legacy-missing) preparationStation carries no station signal at
 * all, so it falls back to the item's own category FOOD/DRINK type —
 * existing product semantics, never an invented routing rule.
 */
export function menuSectionsForItem(item: Pick<MenuItem, "preparationStation">, categoryType: Category["type"] | undefined): MenuSection[] {
  switch (item.preparationStation) {
    case "KITCHEN": return ["KITCHEN"];
    case "BAR": return ["BAR"];
    case "KITCHEN_AND_BAR": return ["KITCHEN", "BAR"];
    default: return categoryType === "DRINK" ? ["BAR"] : ["KITCHEN"];
  }
}

export function mergeWaiterMenu(items: readonly StaticMenuItem[], overlay: ReadonlyMap<string, LiveAvailability>): MenuItem[] {
  return items.map(item => ({ ...item, stock: overlay.get(item.id)?.stock ?? null,
    recipeAvailability: overlay.get(item.id)?.recipeAvailability ?? null,
    availability: overlay.get(item.id)?.availability ?? null }));
}
