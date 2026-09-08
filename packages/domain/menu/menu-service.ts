import { prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { getStockStatusForMenuItems } from "../inventory/inventory-service";
import { getRecipeAvailabilityForMenuItems } from "../inventory/ingredient-service";
import { getAvailabilityForMenuItems } from "./availability-service";
import { buildCacheKey, getOrSet, cacheDel } from "../cache/cache-client";
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
  ReorderCategoriesInput,
  CreateMenuItemInput,
  UpdateMenuItemInput,
  ChangePriceInput,
  MoveToCategoryInput,
  MenuItemFilters,
} from "@rcs/shared";

// Jedina permisija koja pokriva izmenu menija u MVP-u — namerno bez
// finije granulacije (menu.price.edit, menu.availability, ...) dok se ne
// pokaže stvarna potreba (vidi "ne praviti preranu apstrakciju" u planu).
// Ono što JESTE tvrdo zagarantovano: WAITER/KITCHEN/BAR role u seed
// podacima nikad ne dobijaju ovu permisiju (vidi seed.ts).
const MENU_MANAGE = "menu.manage";
const MENU_VIEW = "menu.view";

// ── KEŠ (P0/perf) ───────────────────────────────────────────────────────
//
// Keširaju se ISKLJUČIVO kategorije i "bazni" oblik artikala (naziv/cena/
// dodaci/kategorija) — NIKAD live overlay (zaliha/recepturisana dostupnost/
// operativna dostupnost po lokaciji, vidi listMenuItems ispod), koji uvek
// mora ostati svež po zahtevu (specifikacija: "safe/base menu item data
// only"). TTL je bezbednosna rezerva (rekonstrukcija ako invalidacija
// promaši), STVARNA svežina dolazi od eksplicitne invalidacije POSLE
// uspešne DB izmene (nikad pre) na kraju svake mutacione funkcije ispod.
const MENU_CACHE_TTL_SECONDS = 300;

function categoriesCacheKey(restaurantId: string): string {
  return buildCacheKey(restaurantId, "categories");
}

/**
 * Samo DVE keširane varijante artikala postoje — "all" (bez filtera) i
 * "active" (activeOnly=true, bez ijednog drugog filtera). Bilo koji drugi
 * skup filtera (categoryId/preparationStation/search/type) NIKAD se ne
 * kešira — search posebno bi značio neograničen prostor ključeva. Ovo je
 * namerno uzak obim ("base menu item data only"), ne opšti keš za svaki
 * mogući upit.
 */
type MenuItemsCacheVariant = "all" | "active";

function menuItemsCacheKey(restaurantId: string, variant: MenuItemsCacheVariant): string {
  return buildCacheKey(restaurantId, "menu-items", variant);
}

function baseCacheVariant(filters: MenuItemFilters): MenuItemsCacheVariant | null {
  if (filters.categoryId || filters.preparationStation || filters.search || filters.type) return null;
  return filters.activeOnly ? "active" : "all";
}

async function invalidateMenuItemsCache(restaurantId: string): Promise<void> {
  await cacheDel(menuItemsCacheKey(restaurantId, "all"), menuItemsCacheKey(restaurantId, "active"));
}

// ── KATEGORIJE ──────────────────────────────────────────────────────────

export async function listCategories(ctx: AuthContext) {
  requirePermission(ctx, MENU_VIEW);
  return getOrSet({
    key: categoriesCacheKey(ctx.restaurantId),
    ttlSeconds: MENU_CACHE_TTL_SECONDS,
    loader: () =>
      prisma.menuCategory.findMany({
        where: scopeToRestaurant(ctx),
        orderBy: { sortOrder: "asc" },
      }),
  });
}

export async function createCategory(ctx: AuthContext, input: CreateCategoryInput) {
  requirePermission(ctx, MENU_MANAGE);
  const category = await prisma.menuCategory.create({
    data: { ...input, restaurantId: ctx.restaurantId },
  });
  await cacheDel(categoriesCacheKey(ctx.restaurantId));
  await recordAuditEntry(ctx, {
    entityType: "MenuCategory",
    entityId: category.id,
    action: "menu_category.created",
    newValue: input,
  });
  return category;
}

export async function updateCategory(ctx: AuthContext, categoryId: string, input: UpdateCategoryInput) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await prisma.menuCategory.findFirst({
    where: { id: categoryId, ...scopeToRestaurant(ctx) },
  });
  if (!existing) throw new Error("Kategorija nije pronađena");

  const updated = await prisma.menuCategory.update({
    where: { id: categoryId },
    data: input,
  });
  await cacheDel(categoriesCacheKey(ctx.restaurantId));
  // Kategorija se prikazuje ugnježdena u svakom artiklu (include: { category: true }
  // u listMenuItems) — izmena naziva/statusa kategorije mora obesnažiti i
  // keširane liste artikala, ne samo listu kategorija.
  await invalidateMenuItemsCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuCategory",
    entityId: categoryId,
    action: "menu_category.updated",
    previousValue: { name: existing.name, isActive: existing.isActive, sortOrder: existing.sortOrder },
    newValue: input,
  });
  return updated;
}

export async function reorderCategories(ctx: AuthContext, input: ReorderCategoriesInput) {
  requirePermission(ctx, MENU_MANAGE);

  const owned = await prisma.menuCategory.findMany({
    where: { id: { in: input.orderedIds }, ...scopeToRestaurant(ctx) },
    select: { id: true },
  });
  if (owned.length !== input.orderedIds.length) {
    throw new Error("Jedna ili više kategorija ne pripada ovom restoranu");
  }

  await prisma.$transaction(
    input.orderedIds.map((id, index) =>
      prisma.menuCategory.update({ where: { id }, data: { sortOrder: index } })
    )
  );
  await cacheDel(categoriesCacheKey(ctx.restaurantId));

  await recordAuditEntry(ctx, {
    entityType: "MenuCategory",
    entityId: "bulk-reorder",
    action: "menu_category.reordered",
    newValue: { orderedIds: input.orderedIds },
  });
}

/**
 * Brisanje kategorije koja ima dodeljene artikle je dozvoljeno (FK je
 * ON DELETE SET NULL — artikli postaju "nekategorisani", ne brišu se), ali
 * zahteva eksplicitnu potvrdu (`force`) da administrator ne obriše
 * kategoriju slučajno dok u njoj ima 40 artikala.
 */
export async function deleteCategory(ctx: AuthContext, categoryId: string, force = false) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await prisma.menuCategory.findFirst({
    where: { id: categoryId, ...scopeToRestaurant(ctx) },
  });
  if (!existing) throw new Error("Kategorija nije pronađena");

  const itemCount = await prisma.menuItem.count({ where: { categoryId, deletedAt: null } });
  if (itemCount > 0 && !force) {
    throw new Error(
      `Kategorija ima ${itemCount} artikala. Prosledi force=true da ih premestiš u "nekategorisano" i obrišeš kategoriju.`
    );
  }

  await prisma.menuCategory.delete({ where: { id: categoryId } });
  await cacheDel(categoriesCacheKey(ctx.restaurantId));
  await invalidateMenuItemsCache(ctx.restaurantId); // affected items move to "uncategorized"

  await recordAuditEntry(ctx, {
    entityType: "MenuCategory",
    entityId: categoryId,
    action: "menu_category.deleted",
    previousValue: { name: existing.name, affectedItemCount: itemCount },
  });
}

// ── ARTIKLI ─────────────────────────────────────────────────────────────

export async function listMenuItems(ctx: AuthContext, filters: MenuItemFilters = {}) {
  requirePermission(ctx, MENU_VIEW);
  // P3.3: locationId je OPCIONO — kad konobar traži meni za konkretnu
  // (svoju) lokaciju, server proverava pristup i dodaje status zalihe za
  // TU lokaciju (specifikacija #41/#43: nikad agregat preko lokacija, nikad
  // tuđa lokacija). Admin bez locationId dobija identičan odgovor kao pre
  // P3.3 (bez stock polja) — potpuno aditivno.
  if (filters.locationId) requireLocationAccess(ctx, filters.locationId);

  const loadItems = () =>
    prisma.menuItem.findMany({
      where: {
        ...scopeToRestaurant(ctx),
        deletedAt: null,
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
        ...(filters.preparationStation ? { preparationStation: filters.preparationStation } : {}),
        ...(filters.activeOnly ? { isActive: true } : {}),
        ...(filters.search
          ? { name: { contains: filters.search, mode: "insensitive" as const } }
          : {}),
        ...(filters.type ? { category: { type: filters.type } } : {}),
      },
      include: {
        category: true,
        // P3.2: JEDAN batch-ovan include za sve stavke (ne upit po artiklu) —
        // waiter ekran ovim saznaje da li artikal ima grupe dodataka bez
        // dodatnih rundi ka serveru (specifikacija #63). Prazno za artikle
        // bez vezanih grupa — jeftino po redu.
        modifierGroups: {
          where: { group: { isActive: true } },
          include: { group: { include: { options: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } } } },
          orderBy: { sortOrder: "asc" },
        },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });

  // P0/perf: kešira se ISKLJUČIVO "bazni" (bez-filtera / activeOnly-samo)
  // oblik — nikad proizvoljna kombinacija filtera (search posebno bi bio
  // neograničen prostor ključeva). Bilo koji drugi filter ide direktno na
  // Postgres, nepromenjeno u odnosu na ranije.
  const cacheVariant = baseCacheVariant(filters);
  const items = cacheVariant
    ? await getOrSet({ key: menuItemsCacheKey(ctx.restaurantId, cacheVariant), ttlSeconds: MENU_CACHE_TTL_SECONDS, loader: loadItems })
    : await loadItems();

  if (!filters.locationId) return items;
  // NAPOMENA: sve ispod (zaliha/recepturisana dostupnost/operativna
  // dostupnost) računa se UVEK uživo, bez obzira da li su `items` iznad
  // došli iz keša — ovo je live operativni podatak po lokaciji koji se
  // NIKAD ne kešira (specifikacija: "safe/base menu item data only").

  // P1.4: dva batch-ovana upita paralelno (finished-goods status +
  // recepturisana dostupnost), oba "batch, ne po artiklu" (specifikacija
  // #16/#50/#73). Potpuno aditivno polje — item.stock ostaje nepromenjeno
  // za SVAKI postojeći poziv, recipeAvailability je novo, nezavisno polje.
  const [stockByItem, recipeAvailabilityByItem, availabilityByItem] = await Promise.all([
    getStockStatusForMenuItems(ctx.restaurantId, filters.locationId, items.map((i) => i.id)),
    getRecipeAvailabilityForMenuItems(ctx.restaurantId, filters.locationId, items.map((i) => i.id)),
    getAvailabilityForMenuItems(ctx.restaurantId, filters.locationId, items.map((i) => i.id)),
  ]);
  return items.map((item) => ({
    ...item,
    stock: stockByItem.get(item.id) ?? null,
    recipeAvailability: recipeAvailabilityByItem.get(item.id) ?? null,
    // Operativna (Kuhinja/Šank) dostupnost — POTPUNO nezavisno od stock/
    // recipeAvailability iznad (vidi availability-service.ts). Nikad null:
    // uvek { isAvailable: true, ... } kad override red ne postoji.
    availability: availabilityByItem.get(item.id) ?? { isAvailable: true, reasonCode: null, reasonLabel: null },
  }));
}

export async function createMenuItem(ctx: AuthContext, input: CreateMenuItemInput) {
  requirePermission(ctx, MENU_MANAGE);

  if (input.categoryId) {
    const category = await prisma.menuCategory.findFirst({
      where: { id: input.categoryId, ...scopeToRestaurant(ctx) },
    });
    if (!category) throw new Error("Kategorija ne pripada ovom restoranu");
  }

  const item = await prisma.menuItem.create({
    data: { ...input, restaurantId: ctx.restaurantId },
  });
  await invalidateMenuItemsCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: item.id,
    action: "menu_item.created",
    newValue: { name: input.name, price: input.price, categoryId: input.categoryId ?? null },
  });
  return item;
}

async function getOwnedItem(ctx: AuthContext, itemId: string) {
  const item = await prisma.menuItem.findFirst({
    where: { id: itemId, ...scopeToRestaurant(ctx), deletedAt: null },
  });
  if (!item) throw new Error("Artikal nije pronađen");
  return item;
}

/**
 * Opšta izmena artikla — NE koristi se za promenu cene (vidi changePrice)
 * niti za promenu kategorije (vidi moveToCategory) jer te promene imaju
 * sopstvenu, precizniju audit akciju koju vlasnik traži da posebno vidi.
 */
export async function updateMenuItem(ctx: AuthContext, itemId: string, input: UpdateMenuItemInput) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const { price: _ignoredPrice, categoryId: _ignoredCategoryId, ...rest } = input;

  const updated = await prisma.menuItem.update({ where: { id: itemId }, data: rest });
  await invalidateMenuItemsCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.updated",
    previousValue: existing,
    newValue: rest,
  });
  return updated;
}

/**
 * Unos cene za artikal koji čeka pregled (needsReview=true, isActive=false
 * — vidi seed-menu.ts) NAMERNO, u ISTOJ operaciji, razrešava pregled: item
 * postaje isActive=true (vidljiv konobaru) i needsReview=false/reviewNote=
 * null. Ovo je jedini način da takav artikal ikad postane vidljiv u Waiter
 * POS-u (aktivacija ranije nije postojala — cena se menjala, ali needsReview/
 * isActive ostajali netaknuti, pa je artikal ostajao trajno skriven i posle
 * unosa stvarne cene). Prag "validna cena" je > 0 — unos 0 ne razrešava
 * pregled, jer je 0 sama placeholder vrednost koju needsReview označava.
 * Već aktivni artikli (needsReview=false) menjaju samo price, bez promene
 * ponašanja u odnosu na ranije.
 */
export async function changePrice(ctx: AuthContext, itemId: string, input: ChangePriceInput) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const resolvesReview = existing.needsReview && input.price > 0;

  const updated = await prisma.menuItem.update({
    where: { id: itemId },
    data: {
      price: input.price,
      ...(resolvesReview ? { needsReview: false, reviewNote: null, isActive: true } : {}),
    },
  });
  await invalidateMenuItemsCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.price_changed",
    previousValue: { price: existing.price, needsReview: existing.needsReview, isActive: existing.isActive },
    newValue: {
      price: input.price,
      ...(resolvesReview ? { needsReview: false, isActive: true } : {}),
    },
    reason: input.reason,
  });
  return updated;
}

export async function moveToCategory(ctx: AuthContext, itemId: string, input: MoveToCategoryInput) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  if (input.categoryId) {
    const category = await prisma.menuCategory.findFirst({
      where: { id: input.categoryId, ...scopeToRestaurant(ctx) },
    });
    if (!category) throw new Error("Kategorija ne pripada ovom restoranu");
  }

  const updated = await prisma.menuItem.update({
    where: { id: itemId },
    data: { categoryId: input.categoryId },
  });
  await invalidateMenuItemsCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.category_changed",
    previousValue: { categoryId: existing.categoryId },
    newValue: { categoryId: input.categoryId },
  });
  return updated;
}

export async function setAvailability(ctx: AuthContext, itemId: string, isAvailable: boolean) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const updated = await prisma.menuItem.update({ where: { id: itemId }, data: { isAvailable } });
  await invalidateMenuItemsCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.availability_changed",
    previousValue: { isAvailable: existing.isAvailable },
    newValue: { isAvailable },
  });
  return updated;
}

export async function setActive(ctx: AuthContext, itemId: string, isActive: boolean) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const updated = await prisma.menuItem.update({ where: { id: itemId }, data: { isActive } });
  await invalidateMenuItemsCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: isActive ? "menu_item.enabled" : "menu_item.disabled",
    previousValue: { isActive: existing.isActive },
    newValue: { isActive },
  });
  return updated;
}

export async function archiveMenuItem(ctx: AuthContext, itemId: string) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const updated = await prisma.menuItem.update({
    where: { id: itemId },
    data: { deletedAt: new Date(), isActive: false },
  });
  await invalidateMenuItemsCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.archived",
    previousValue: { name: existing.name, price: existing.price },
  });
  return updated;
}

/**
 * Fizičko brisanje. Bezbedno u MVP-u jer Order/OrderItem modeli (Faza 3)
 * čuvaju immutable snapshot naziva/cene u trenutku prodaje — ne referenciraju
 * MenuItem preko FK-a koji bi blokirao brisanje niti bi izgubili istorijske
 * podatke ako se MenuItem obriše kasnije.
 */
export async function deleteMenuItem(ctx: AuthContext, itemId: string) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  await prisma.menuItem.delete({ where: { id: itemId } });
  await invalidateMenuItemsCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: itemId,
    action: "menu_item.deleted",
    previousValue: existing,
  });
}

export async function duplicateMenuItem(ctx: AuthContext, itemId: string) {
  requirePermission(ctx, MENU_MANAGE);
  const existing = await getOwnedItem(ctx, itemId);

  const baseSlug = `${existing.slug}-kopija`;
  let slug = baseSlug;
  let suffix = 2;
  while (await prisma.menuItem.findFirst({ where: { restaurantId: ctx.restaurantId, slug } })) {
    slug = `${baseSlug}-${suffix++}`;
  }

  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = existing;
  const duplicate = await prisma.menuItem.create({
    data: { ...rest, name: `${existing.name} (kopija)`, slug, isActive: false },
  });
  await invalidateMenuItemsCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: duplicate.id,
    action: "menu_item.duplicated",
    newValue: { duplicatedFrom: itemId },
  });
  return duplicate;
}
