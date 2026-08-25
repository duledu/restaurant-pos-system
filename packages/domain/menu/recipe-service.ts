/**
 * P1: Normativi/recepture — koje sirovine (i u kojoj količini) ulaze u JEDAN
 * MenuItem. Namerno odvojen fajl od menu-service.ts, isti obrazac kao
 * modifier-service.ts (srodna ali konceptualno odvojena celina).
 *
 * P1.3: recepture su POVEZANE sa prodajom (vidi ingredient-service.ts
 * validateAndDecrementIngredientsInTx, pozvano iz billing-service.ts).
 *
 * DUAL-STOCK PRELAZAK (P1.3): kad artikal koji ima MenuItem.trackStock=true
 * (gotov-artikal zaliha) dobije SVOJU PRVU liniju recepture, taj artikal
 * automatski i atomski prelazi na sirovinski model — trackStock se gasi U
 * ISTOJ transakciji kao kreiranje linije (addRecipeLine ispod). Stari
 * InventoryItem red i CELA njegova istorija (InventoryMovement) OSTAJU
 * netaknuti zauvek — samo se prestaju aktivno koristiti za buduće prodaje.
 * Namerno NEMA suprotnog automatizma: brisanje POSLEDNJE linije recepture
 * NIKAD ne vraća trackStock na true (vidi removeRecipeLine) — to bi moglo
 * tiho reaktivirati staro/zastarelo stanje zaliha. Vraćanje na gotov-artikal
 * model je uvek eksplicitna, posebna akcija (inventory-service.ts
 * setTrackingEnabled), nikad automatska posledica brisanja recepture.
 */
import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { convertUnit, type UnitOfMeasure } from "../inventory/unit-of-measure";

async function loadOwnedMenuItem(ctx: AuthContext, menuItemId: string) {
  const menuItem = await prisma.menuItem.findFirst({
    where: { id: menuItemId, ...scopeToRestaurant(ctx) },
  });
  if (!menuItem) throw new Error("Artikal nije pronađen");
  return menuItem;
}

/**
 * Puna receptura artikla — ingredient uključen radi naziva/jedinice bez
 * dodatnog poziva sa strane klijenta.
 */
export async function getRecipe(ctx: AuthContext, menuItemId: string) {
  requirePermission(ctx, "menu.view");
  await loadOwnedMenuItem(ctx, menuItemId);

  return prisma.menuItemIngredient.findMany({
    where: { menuItemId },
    include: { ingredient: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Dodaje liniju recepture. `unit` je OPCIONO — ako je prosleđeno i različito
 * od sirovine sopstvene jedinice, količina se KONVERTUJE (convertUnit,
 * baca grešku za nekompatibilne dimenzije — npr. GRAM -> LITER, ili PIECE
 * mešano sa bilo čim drugim) u sirovinu sopstvenu (kanoničku) jedinicu PRE
 * upisa — `MenuItemIngredient.quantity` je UVEK u Ingredient.unit, isto kao
 * pre ove izmene (bez schema promene). Ako `unit` izostane, ponašanje je
 * identično staroj verziji (količina se tumači direktno u sirovinoj jedinici).
 */
export async function addRecipeLine(
  ctx: AuthContext,
  menuItemId: string,
  input: { ingredientId: string; quantity: number; unit?: UnitOfMeasure }
) {
  requirePermission(ctx, "inventory.manage");
  const menuItem = await loadOwnedMenuItem(ctx, menuItemId);

  const ingredient = await prisma.ingredient.findFirst({
    where: { id: input.ingredientId, ...scopeToRestaurant(ctx) },
  });
  if (!ingredient) throw new Error("Sirovina nije pronađena");
  if (input.quantity <= 0) throw new Error("Količina mora biti pozitivna");

  const canonicalQuantity =
    input.unit && input.unit !== ingredient.unit
      ? convertUnit(input.quantity, input.unit, ingredient.unit)
      : input.quantity;

  const existing = await prisma.menuItemIngredient.findUnique({
    where: { menuItemId_ingredientId: { menuItemId, ingredientId: input.ingredientId } },
  });
  if (existing) throw new Error("Ova sirovina je već u recepturi — izmenite postojeću liniju umesto dodavanja nove");

  const { line, transitioned } = await prisma.$transaction(async (tx) => {
    const countBefore = await tx.menuItemIngredient.count({ where: { menuItemId } });

    const created = await tx.menuItemIngredient.create({
      data: { menuItemId, ingredientId: input.ingredientId, quantity: canonicalQuantity },
      include: { ingredient: true },
    });

    // Atomski prelazak: OVO je bila prva linija I artikal je do sada koristio
    // gotov-artikal zalihu — ugasi je u ISTOJ transakciji (vidi napomenu na
    // vrhu fajla). Bezopasno čak i u retkoj konkurentnoj trci (dva različita
    // admina dodaju prvu liniju istovremeno): oba bi nezavisno odlučila istu
    // ciljnu vrednost (trackStock=false), nema korupcije stanja.
    let didTransition = false;
    if (countBefore === 0 && menuItem.trackStock) {
      await tx.menuItem.update({ where: { id: menuItemId }, data: { trackStock: false } });
      didTransition = true;
    }

    return { line: created, transitioned: didTransition };
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: menuItemId,
    action: "recipe.line_added",
    newValue: {
      ingredientId: input.ingredientId,
      ingredientName: ingredient.name,
      quantity: canonicalQuantity,
      unit: ingredient.unit,
      enteredQuantity: input.quantity,
      enteredUnit: input.unit ?? ingredient.unit,
    },
  });

  if (transitioned) {
    await recordAuditEntry(ctx, {
      entityType: "MenuItem",
      entityId: menuItemId,
      action: "inventory.model_switched_to_recipe",
      previousValue: { trackStock: true },
      newValue: {
        trackStock: false,
        reason:
          "Prva linija recepture kreirana — automatski prelazak sa gotov-artikal zaliha na sirovinski normativ. Postojeći InventoryItem red i istorija kretanja su OČUVANI, samo se više ne koriste za buduće prodaje.",
      },
    });
  }

  return line;
}

export async function updateRecipeLine(
  ctx: AuthContext,
  recipeLineId: string,
  input: { quantity: number; unit?: UnitOfMeasure }
) {
  requirePermission(ctx, "inventory.manage");
  if (input.quantity <= 0) throw new Error("Količina mora biti pozitivna");

  const line = await prisma.menuItemIngredient.findFirst({
    where: { id: recipeLineId, menuItem: scopeToRestaurant(ctx) },
    include: { ingredient: true, menuItem: { select: { id: true } } },
  });
  if (!line) throw new Error("Linija recepture nije pronađena");

  const canonicalQuantity =
    input.unit && input.unit !== line.ingredient.unit
      ? convertUnit(input.quantity, input.unit, line.ingredient.unit)
      : input.quantity;

  const updated = await prisma.menuItemIngredient.update({
    where: { id: recipeLineId },
    data: { quantity: canonicalQuantity },
    include: { ingredient: true },
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: line.menuItem.id,
    action: "recipe.line_updated",
    previousValue: { ingredientId: line.ingredientId, quantity: line.quantity.toString() },
    newValue: {
      ingredientId: line.ingredientId,
      ingredientName: line.ingredient.name,
      quantity: canonicalQuantity,
      enteredQuantity: input.quantity,
      enteredUnit: input.unit ?? line.ingredient.unit,
    },
  });

  return updated;
}

/**
 * Uklanja liniju recepture. NAMERNO nikad ne dira MenuItem.trackStock — čak
 * i ako ovo bude POSLEDNJA preostala linija (receptura postaje prazna), stari
 * gotov-artikal model se NE reaktivira automatski (vidi napomenu na vrhu
 * fajla). Artikal ostaje "normativ nije definisan" dok neko eksplicitno ne
 * doda novu liniju (opet prolazi kroz addRecipeLine — ali tada je
 * menuItem.trackStock već false, pa nema šta da se ugasi po drugi put) ili
 * dok OWNER/ADMIN/MANAGER eksplicitno ne pozove setTrackingEnabled da vrati
 * gotov-artikal praćenje.
 */
export async function removeRecipeLine(ctx: AuthContext, recipeLineId: string) {
  requirePermission(ctx, "inventory.manage");

  const line = await prisma.menuItemIngredient.findFirst({
    where: { id: recipeLineId, menuItem: scopeToRestaurant(ctx) },
    include: { ingredient: true, menuItem: { select: { id: true } } },
  });
  if (!line) throw new Error("Linija recepture nije pronađena");

  await prisma.menuItemIngredient.delete({ where: { id: recipeLineId } });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: line.menuItem.id,
    action: "recipe.line_removed",
    previousValue: { ingredientId: line.ingredientId, ingredientName: line.ingredient.name, quantity: line.quantity.toString() },
  });

  return { removed: true };
}

/**
 * Batch provera: koji od datih MenuItemId-jeva TRENUTNO imaju bar jednu
 * liniju recepture. Koristi ga inventory-service.ts kao "recepturisan
 * artikal uvek pobeđuje" odbranu u dubinu (double-deduction guard) — čak i
 * ako legacy/loša kombinacija (trackStock=true I receptura postoji) nekako
 * postoji za isti MenuItem (npr. neko ručno ponovo uključio gotov-artikal
 * praćenje bez uklanjanja recepture), naplata NIKAD tiho ne skida oba —
 * receptura uvek pobeđuje.
 */
export async function getMenuItemIdsWithRecipes(
  db: Prisma.TransactionClient | typeof prisma,
  menuItemIds: string[]
): Promise<Set<string>> {
  if (menuItemIds.length === 0) return new Set();
  const rows = await db.menuItemIngredient.findMany({
    where: { menuItemId: { in: menuItemIds } },
    select: { menuItemId: true },
    distinct: ["menuItemId"],
  });
  return new Set(rows.map((r) => r.menuItemId));
}

export interface RecipeOverviewItem {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  ingredientCount: number;
  isConfigured: boolean;
}

/**
 * Normativi pregled — jedan red po MenuItem-u sa brojem sastojaka i
 * konfigurisan/nije-konfigurisan statusom. Search/kategorija/status filteri
 * rade na klijentu nad ovim rezultatom (isti obrazac kao Meni/Zalihe
 * stranice — jedan upit, bez paginacije na server strani u ovoj fazi).
 */
export async function listRecipeOverview(ctx: AuthContext): Promise<RecipeOverviewItem[]> {
  requirePermission(ctx, "menu.view");

  const [menuItems, counts] = await Promise.all([
    prisma.menuItem.findMany({
      where: { restaurantId: ctx.restaurantId, deletedAt: null },
      select: { id: true, name: true, categoryId: true, category: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.menuItemIngredient.groupBy({
      by: ["menuItemId"],
      where: { menuItem: { restaurantId: ctx.restaurantId } },
      _count: { _all: true },
    }),
  ]);

  const countByItem = new Map(counts.map((c) => [c.menuItemId, c._count._all]));

  return menuItems.map((m) => {
    const ingredientCount = countByItem.get(m.id) ?? 0;
    return {
      id: m.id,
      name: m.name,
      categoryId: m.categoryId,
      categoryName: m.category?.name ?? null,
      ingredientCount,
      isConfigured: ingredientCount > 0,
    };
  });
}
