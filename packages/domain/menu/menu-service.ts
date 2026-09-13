import { prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { getStockStatusForMenuItems } from "../inventory/inventory-service";
import { getRecipeAvailabilityForMenuItems } from "../inventory/ingredient-service";
import { getAvailabilityForMenuItems } from "./availability-service";
import { buildCacheKey, getOrSet, cacheDel, cacheIncr, cacheEnsureCounter } from "../cache/cache-client";
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

// ── VERZIJA STATIČKOG MENIJA (P0.2a) ────────────────────────────────────
//
// Predstavlja ISKLJUČIVO statički/sporo-promenljivi meni obuhvaćen P0.1a
// snapshot-om (kategorije, artikli, cena/porez, modifikatori) — NIKAD live
// operativno stanje (packages/domain/menu/availability-service.ts —
// PAŽNJA: ta funkcija se TAKOĐE zove `setAvailability`, ali menja
// MenuItemAvailability, po-lokacijsku LIVE tabelu, POTPUNO odvojenu od
// `MenuItem.isAvailable` — statičkog, restoranom-širokog polja koje menja
// OVAJ fajl. Nikad ne bumpovati verziju iz availability-service.ts.) niti
// zalihu/recepturu (packages/domain/inventory/*) — te ostaju nekeširane,
// uvek-uživo, van dometa ove verzije po dizajnu.
//
// Redis INCR (atomaran, vidi cache-client.ts cacheIncr) — nikad
// read-then-write, da dva konkurentna admin uređivanja nikad ne izgube
// inkrement.
//
// P0.2a KOREKCIJA: verzija 0 je ranije značila i "ključ nikad nije
// postojao" I "Redis nedostupan/greška" — ISTA vrednost za dva potpuno
// različita stanja. Novi restoran bez ijedne izmene bi zauvek prijavljivao
// "0", identično kao stvarni Redis pad, pa bi budući klijent (P0.2b+) morao
// da tretira "0" kao "nepoznato" i osvežava meni na SVAKOJ proveri —
// upravo ono što P0.2 treba da spreči.
//
// Ispravka: getMenuVersion sada ATOMARNO OBEZBEĐUJE da ključ postoji (SET
// NX GET, vidi cacheEnsureCounter) — nedostajući ključ se inicijalizuje na
// 1 i TA vrednost se vraća, postojeći ključ se NIKAD ne dira. `null`
// (nikad 0) je sada JEDINI, nedvosmisleni signal za "Redis nedostupan/
// greška, verzija nepoznata" — pozivalac MORA tretirati `null` kao "moram
// preuzeti pun snapshot", dok bilo koji stvaran broj (uključujući 1) je
// stabilna, poverljiva vrednost između provera.
//
// ── P0.2b — KODIFIKOVAN UGOVOR ZA BUDUĆEG KLIJENTA (P0.2c/P0.3) ─────────
// Ne implementira se ovde (nema klijenta/polling-a još), ali OVO su jedina
// dozvoljena tumačenja rezultata getMenuVersion/GET /api/pos/menu/version:
//
//   VERZIJA SE PROMENILA (broj != poslednje zapamćeni broj)
//     -> pun refresh statičkog snapshot-a (GET .../menu/snapshot?fresh=1).
//   VERZIJA JE `null` (Redis nedostupan/nepoznato)
//     -> pun refresh, ISTO kao promena — nikad se ne tretira kao "bez izmene".
//   VERZIJA JE ISTA (broj == poslednje zapamćeni broj)
//     -> sme se verovati lokalnom stanju, ALI SAMO unutar ograničenog
//        prozora — vidi granicu ispod. Nikad trajno.
//   MAKSIMALNI period bez bezuslovnog pomirenja: 5 MINUTA — po isteku,
//     pun refresh se radi BEZ OBZIRA na to šta verzija kaže. Ovo NIJE
//     opciono: pokriva izgubljen Redis bump, neuspelu invalidaciju keša, i
//     lokalni (budući IndexedDB) snapshot koji nadživi bilo koji server-side
//     TTL (danas 300s za keš artikala/kategorija).
//   POVRATAK aplikacije iz pozadine/reconnect: ODMAH proveriti verziju; ako
//     je aplikacija bila u pozadini duže od 5 minuta, forsirati pun refresh
//     bez obzira na verziju (isti razlog kao gornja granica).
//   POČETAK SMENE (P0.1a/b): UVEK pun snapshot, bez obzira na bilo koju
//     ranije zapamćenu verziju — ponašanje se ovim ne menja.
// ─────────────────────────────────────────────────────────────────────────
function menuVersionCacheKey(restaurantId: string): string {
  return buildCacheKey(restaurantId, "menu-version");
}

export async function getMenuVersion(restaurantId: string): Promise<number | null> {
  return cacheEnsureCounter(menuVersionCacheKey(restaurantId), 1);
}

/**
 * P0.2b — waiter-facing verzija sa autorizacionom granicom (GET /api/pos/
 * menu/version). Verzija je restoran-široka, ne po-lokaciji podatak, ali i
 * dalje proveravamo pristup TRAŽENOJ lokaciji (isti obrazac kao
 * getWaiterMenuSnapshot/getWaiterAvailabilityOverlay) da odgovor ne otkrije
 * čak ni POSTOJANJE verzije zaposlenom bez pristupa toj lokaciji.
 */
export async function getWaiterMenuVersion(ctx: AuthContext, locationId: string): Promise<number | null> {
  requirePermission(ctx, MENU_VIEW);
  requireLocationAccess(ctx, locationId);
  return getMenuVersion(ctx.restaurantId);
}

export async function bumpMenuVersion(restaurantId: string): Promise<void> {
  await cacheIncr(menuVersionCacheKey(restaurantId));
  // cacheIncr nikad ne baca (vidi cache-client.ts) — Redis nedostupan znači
  // "verzija ostaje nepromenjena/nepoznata", NIKAD razlog da mutacija
  // iznad ove linije bude prijavljena kao neuspešna.
}

/**
 * JEDINO mesto koje invalidira keširane menu-items redove I bumpuje
 * menuVersion — UVEK zajedno, UVEK POSLE uspešne DB mutacije, nikad pre
 * (bump je infrastruktura za detekciju promene, ne sme lažno najaviti
 * izmenu koja se nije stvarno desila). Poziva se JEDNOM po logičkoj Admin
 * operaciji — i iz ovog fajla i iz modifier-service.ts (koji menja
 * modifierGroups/options UGNJEŽDENE u istu keširanu listu, a nije ovaj
 * modul) — nikad odvojeno, da jedna logička izmena nikad ne bumpuje
 * verziju više od jednom.
 */
export async function invalidateMenuSnapshotCache(restaurantId: string): Promise<void> {
  await invalidateMenuItemsCache(restaurantId);
  await bumpMenuVersion(restaurantId);
}

// ── KATEGORIJE ──────────────────────────────────────────────────────────

export async function listCategories(ctx: AuthContext, options?: { fresh?: boolean }) {
  requirePermission(ctx, MENU_VIEW);
  return getOrSet({
    key: categoriesCacheKey(ctx.restaurantId),
    ttlSeconds: MENU_CACHE_TTL_SECONDS,
    fresh: options?.fresh,
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
  await bumpMenuVersion(ctx.restaurantId);
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
  await invalidateMenuSnapshotCache(ctx.restaurantId);

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
  await bumpMenuVersion(ctx.restaurantId);

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
  await invalidateMenuSnapshotCache(ctx.restaurantId); // affected items move to "uncategorized"

  await recordAuditEntry(ctx, {
    entityType: "MenuCategory",
    entityId: categoryId,
    action: "menu_category.deleted",
    previousValue: { name: existing.name, affectedItemCount: itemCount },
  });
}

// ── ARTIKLI ─────────────────────────────────────────────────────────────

/**
 * P0.2b — jedino mesto koje računa live overlay (zaliha/receptura/operativna
 * dostupnost) — koriste ga i listMenuItems ispod (Admin/Order put, embedded
 * u puni artikal) I getWaiterAvailabilityOverlay (P0.2b, samostalan mali
 * endpoint). Nikad se ne kešira (uvek uživo, po dizajnu) — vidi napomenu na
 * pozivnim mestima.
 */
async function computeLiveOverlay(restaurantId: string, locationId: string, menuItemIds: string[]) {
  const [stockByItem, recipeAvailabilityByItem, availabilityByItem] = await Promise.all([
    getStockStatusForMenuItems(restaurantId, locationId, menuItemIds),
    getRecipeAvailabilityForMenuItems(restaurantId, locationId, menuItemIds),
    getAvailabilityForMenuItems(restaurantId, locationId, menuItemIds),
  ]);
  return menuItemIds.map((id) => ({
    menuItemId: id,
    stock: stockByItem.get(id) ?? null,
    recipeAvailability: recipeAvailabilityByItem.get(id) ?? null,
    // Operativna (Kuhinja/Šank) dostupnost — POTPUNO nezavisno od stock/
    // recipeAvailability iznad (vidi availability-service.ts). Nikad null:
    // uvek { isAvailable: true, ... } kad override red ne postoji.
    availability: availabilityByItem.get(id) ?? { isAvailable: true, reasonCode: null, reasonLabel: null },
  }));
}

export async function listMenuItems(ctx: AuthContext, filters: MenuItemFilters = {}, options?: { fresh?: boolean }) {
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
    ? await getOrSet({ key: menuItemsCacheKey(ctx.restaurantId, cacheVariant), ttlSeconds: MENU_CACHE_TTL_SECONDS, fresh: options?.fresh, loader: loadItems })
    : await loadItems();

  if (!filters.locationId) return items;
  // NAPOMENA: sve ispod (zaliha/recepturisana dostupnost/operativna
  // dostupnost) računa se UVEK uživo, bez obzira da li su `items` iznad
  // došli iz keša — ovo je live operativni podatak po lokaciji koji se
  // NIKAD ne kešira (specifikacija: "safe/base menu item data only").
  const overlayById = new Map((await computeLiveOverlay(ctx.restaurantId, filters.locationId, items.map((i) => i.id))).map((o) => [o.menuItemId, o]));
  return items.map((item) => {
    const overlay = overlayById.get(item.id)!;
    return { ...item, stock: overlay.stock, recipeAvailability: overlay.recipeAvailability, availability: overlay.availability };
  });
}

/**
 * P0.2b — Waiter live availability overlay (Instant Waiter Engine).
 *
 * Zaseban, MALI endpoint koji vraća ISKLJUČIVO live operativni sloj (zaliha/
 * receptura/operativna dostupnost po lokaciji) za SVE trenutno aktivne
 * artikle — NIKAD ime/cenu/porez/kategoriju/dodatke (ta polja su u P0.1a
 * /api/pos/menu/snapshot). Zamenjuje privremeno ponovno korišćenje
 * /api/admin/menu/items od strane P0.1b šift-pripreme.
 *
 * Nula nove poslovne logike: `computeLiveOverlay` je ISTA funkcija koju
 * listMenuItems iznad koristi za Admin/Order put — samo je ovde POZVANA
 * samostalno, bez punog artikal payload-a oko nje. Lista artikala za koje
 * se računa dolazi iz KEŠIRANE "active" varijante (ista kao snapshot) —
 * jeftino, i dosledno tome koji artikli uopšte postoje u trenutnom
 * statičkom snapshot-u konobara.
 */
export async function getWaiterAvailabilityOverlay(ctx: AuthContext, locationId: string) {
  requireLocationAccess(ctx, locationId);
  const items = await listMenuItems(ctx, { activeOnly: true });
  const overlay = await computeLiveOverlay(ctx.restaurantId, locationId, items.map((i) => i.id));
  return { locationId, items: overlay };
}

/**
 * P0.1a — Waiter menu snapshot (Instant Waiter Engine).
 *
 * Vraća ISKLJUČIVO statički/sporo-promenljivi oblik menija (kategorije +
 * aktivni artikli sa cenom/porezom/dodacima) potreban konobaru da lokalno
 * radi ceo šift bez ponovnog preuzimanja istog payload-a po svakom stolu.
 * NAMERNO ne poziva stock/recepturisanu/operativnu dostupnost — to je
 * "live" sloj koji ostaje zaseban (P0.2b: getWaiterAvailabilityOverlay),
 * nikad ne sme da uđe u ovaj keširani/retko-menjani snapshot. locationId se
 * koristi ISKLJUČIVO za autorizacionu granicu (isti obrazac kao svaki drugi
 * pristup po lokaciji), ne utiče na sadržaj — MenuItem/MenuCategory nisu
 * po-lokaciji podaci.
 *
 * Nula duplirane query logike: oba poziva ispod su POSTOJEĆE, već keširane
 * funkcije (listCategories/listMenuItems bez locationId) — ovaj sloj samo
 * orkestrira, ne ponavlja Prisma select/include.
 *
 * P0.2b KOREKCIJA — snapshot/verzija SAMOKONZISTENTNOST (bila je poznata
 * trka): `Promise.all([listCategories, listMenuItems, getMenuVersion])` je
 * PARALELNO, ali NIJE ATOMARNO — admin mutacija (DB upis + cache
 * invalidacija + version bump) može uspeti TAČNO dok su categories/items
 * već u letu, ali PRE nego što se getMenuVersion završi. Rezultat bi bio
 * odgovor koji tvrdi "menuVersion: 11" dok categories/items i dalje nose
 * podatke od verzije 10 — klijent bi tu (staru) verziju smatrao trenutnom
 * zauvek, do isteka granice od 5 minuta.
 *
 * Ispravka: verzija se čita PRE i POSLE čitanja categories/items
 * (`versionBefore`/`versionAfter`), NIKAD paralelno sa njima:
 *   - oba broja i JEDNAKA -> statički podaci nisu mogli da se promene dok
 *     smo ih čitali (bump je atomaran) -> bezbedno tvrdimo TU verziju.
 *   - oba broja ali RAZLIČITA -> mutacija se desila TOKOM čitanja -> ovaj
 *     pokušaj se ODBACUJE, ponavlja se sa `fresh: true` (nikad sa istim
 *     potencijalno zaostalim Redis unosom koji je i doveo do trke) —
 *     ograničeno na MAX_SNAPSHOT_ATTEMPTS pokušaja, NIKAD beskonačna petlja.
 *   - BILO KOJA vrednost `null` (Redis nedostupan) -> nemamo osnovu da
 *     dokažemo stabilnost -> vraćamo autoritativne (upravo pročitane)
 *     categories/items, ali `menuVersion: null` — NIKAD izmišljen broj.
 * Ako se pokušaji iscrpe pod kontinuiranim mutacijama, poslednji pokušaj je
 * JEDAN autoritativan `fresh` snapshot vraćen sa `menuVersion: null` —
 * nikad se ne tvrdi brojčana verzija koju nismo dokazali stabilnom.
 *
 * `options.fresh` i dalje postoji za pozivaoca (npr. `?fresh=1` kad je
 * KLIJENT već otkrio neslaganje preko jeftine /menu/version provere) —
 * prosleđuje se kao polazna vrednost prvog pokušaja; svaki NAREDNI pokušaj
 * (posle otkrivene trke) je UVEK fresh, bez obzira na `options.fresh`.
 */
const MAX_SNAPSHOT_ATTEMPTS = 2;

export async function getWaiterMenuSnapshot(ctx: AuthContext, locationId: string, options?: { fresh?: boolean }) {
  requireLocationAccess(ctx, locationId);

  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt++) {
    const fresh = attempt > 1 || Boolean(options?.fresh);
    const versionBefore = await getMenuVersion(ctx.restaurantId);
    const [categories, items] = await Promise.all([
      listCategories(ctx, { fresh }),
      listMenuItems(ctx, { activeOnly: true }, { fresh }),
    ]);
    const versionAfter = await getMenuVersion(ctx.restaurantId);

    if (versionBefore === null || versionAfter === null) {
      return { restaurantId: ctx.restaurantId, locationId, categories, items, menuVersion: null };
    }
    if (versionBefore === versionAfter) {
      return { restaurantId: ctx.restaurantId, locationId, categories, items, menuVersion: versionBefore };
    }
    // Verzija se promenila TOKOM čitanja — odbacujemo ovaj pokušaj i
    // ponavljamo (naredni pokušaj je uvek fresh, vidi gore).
  }

  // Iscrpljeni pokušaji pod kontinuiranim mutacijama — jedan poslednji
  // autoritativan (fresh) pokušaj, ali NIKAD sa tvrđenjem brojčane verzije
  // koju nismo dokazali stabilnom.
  const [categories, items] = await Promise.all([
    listCategories(ctx, { fresh: true }),
    listMenuItems(ctx, { activeOnly: true }, { fresh: true }),
  ]);
  return { restaurantId: ctx.restaurantId, locationId, categories, items, menuVersion: null };
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
  await invalidateMenuSnapshotCache(ctx.restaurantId);

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
  await invalidateMenuSnapshotCache(ctx.restaurantId);

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
  await invalidateMenuSnapshotCache(ctx.restaurantId);

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
  await invalidateMenuSnapshotCache(ctx.restaurantId);

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
  await invalidateMenuSnapshotCache(ctx.restaurantId);

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
  await invalidateMenuSnapshotCache(ctx.restaurantId);

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
  await invalidateMenuSnapshotCache(ctx.restaurantId);

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
  await invalidateMenuSnapshotCache(ctx.restaurantId);

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
  await invalidateMenuSnapshotCache(ctx.restaurantId);

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: duplicate.id,
    action: "menu_item.duplicated",
    newValue: { duplicatedFrom: itemId },
  });
  return duplicate;
}
