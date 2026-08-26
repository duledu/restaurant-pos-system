/**
 * P1: Normativi/sirovine — sirovinski lager (Ingredient/IngredientStock/
 * IngredientMovement). NAMERNO potpuno odvojeno od inventory-service.ts
 * (koji prati gotov MenuItem "na stanju") — vidi napomenu na vrhu te
 * sekcije u schema.prisma. Isti obrasci (atomični uslovni UPDATE za
 * konkurentnost, ledger uz svaku promenu, requirePermission/
 * requireLocationAccess/scopeToRestaurant, recordAuditEntry) su namerno
 * ponovo iskorišćeni odavde — dokazano ispravni, nema razloga za novi stil.
 *
 * P1.2: `validateAndDecrementIngredientsInTx` (na dnu fajla) POVEZUJE
 * recepture sa naplatom — poziva se iz billing-service.ts/completePayment,
 * unutar ISTE transakcije kao gotov-proizvod ekvivalent
 * (inventory-service.ts validateAndDecrementInventoryInTx). Namerno isti
 * obrazac: agregacija po (ovde: sirovini, ne artiklu) PRE mutacije, atomični
 * uslovni UPDATE za konkurentnost, @@unique(paymentId, ingredientId) kao
 * idempotency brava, InsufficientIngredientStockError kao koherentna,
 * agregirana greška.
 */
import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { ALL_UNITS, unitLabelSr, type UnitOfMeasure } from "./unit-of-measure";

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Agregirana greška nedovoljnih sirovina — namerno nosi SVE nedostajuće
 * sirovine odjednom (ne samo prvu na koju se naiđe), tako da konobar/kasa
 * odmah vidi kompletan spisak umesto da otkriva nedostatke jedan po jedan
 * (P1.2 zahtev). Nikad ne izlaže interne ID-jeve — samo naziv/dostupno/
 * potrebno/jedinica, bezbedno za direktan prikaz na UI.
 */
export class InsufficientIngredientStockError extends Error {
  readonly items: Array<{ name: string; available: string; required: string; unit: UnitOfMeasure }>;

  constructor(items: Array<{ name: string; available: string; required: string; unit: UnitOfMeasure }>) {
    const lines = items
      .map((i) => `${i.name} — dostupno: ${i.available} ${unitLabelSr(i.unit)}, potrebno: ${i.required} ${unitLabelSr(i.unit)}`)
      .join("\n");
    super(`Nema dovoljno sirovina za završetak prodaje.\n${lines}`);
    this.name = "InsufficientIngredientStockError";
    this.items = items;
  }
}

/**
 * P1.6: artikal je eksplicitno konfigurisan na RECIPE metodu praćenja, ali
 * NEMA nijednu liniju recepture ("Normativ nije podešen") — NAMERNO
 * blokirano na SVE tri tačke (dodavanje u porudžbinu, slanje, naplata), ne
 * tiho dozvoljeno kao "prodaja bez odbitka". Eksplicitna RECIPE metoda
 * predstavlja svesnu nameru koja MORA biti podržana stvarnom konfiguracijom
 * pre nego što novac promeni vlasnika — u suprotnom bi to bio stvarni
 * curenje zalihe (prodaja bez ijednog odbitka sirovina).
 */
export class RecipeNotConfiguredError extends Error {
  readonly items: Array<{ menuItemId: string; name: string }>;

  constructor(items: Array<{ menuItemId: string; name: string }>) {
    const names = items.map((i) => i.name).join(", ");
    super(`Normativ nije podešen za: ${names}. Dodajte bar jednu sirovinu u recepturu pre prodaje.`);
    this.name = "RecipeNotConfiguredError";
    this.items = items;
  }
}

// ─── Create / read ──────────────────────────────────────────────────────────

async function assertOwnedActiveInventoryCategory(ctx: AuthContext, inventoryCategoryId: string) {
  const category = await prisma.inventoryCategory.findFirst({
    where: { id: inventoryCategoryId, restaurantId: ctx.restaurantId },
  });
  if (!category) throw new Error("Kategorija zaliha nije pronađena");
  if (!category.isActive) throw new Error("Kategorija zaliha je deaktivirana");
}

export interface CreateIngredientInput {
  name: string;
  unit: UnitOfMeasure;
  category?: string;
  sku?: string;
  /** P1.5: KUHINJA/ŠANK -> podkategorija dodela (InventoryCategory) — opciono na kreiranju. */
  inventoryCategoryId?: string;
}

export async function createIngredient(ctx: AuthContext, input: CreateIngredientInput) {
  requirePermission(ctx, "inventory.manage");

  const name = input.name.trim();
  if (!name) throw new Error("Naziv sirovine je obavezan");
  if (name.length > 120) throw new Error("Naziv sirovine je predugačak (max 120 znakova)");
  if (!ALL_UNITS.includes(input.unit)) throw new Error("Nepoznata jedinica mere");
  if (input.inventoryCategoryId) await assertOwnedActiveInventoryCategory(ctx, input.inventoryCategoryId);

  const ingredient = await prisma.ingredient.create({
    data: {
      restaurantId: ctx.restaurantId,
      name,
      unit: input.unit,
      category: input.category?.trim() || null,
      sku: input.sku?.trim() || null,
      inventoryCategoryId: input.inventoryCategoryId ?? null,
    },
  });

  await recordAuditEntry(ctx, {
    entityType: "Ingredient",
    entityId: ingredient.id,
    action: "ingredient.created",
    newValue: { name, unit: input.unit, category: input.category, sku: input.sku, inventoryCategoryId: input.inventoryCategoryId ?? null },
  });

  return ingredient;
}

export interface UpdateIngredientInput {
  name?: string;
  unit?: UnitOfMeasure;
  category?: string | null;
  sku?: string | null;
  inventoryCategoryId?: string | null;
}

export async function updateIngredient(ctx: AuthContext, ingredientId: string, input: UpdateIngredientInput) {
  requirePermission(ctx, "inventory.manage");

  const ingredient = await prisma.ingredient.findFirst({
    where: { id: ingredientId, restaurantId: ctx.restaurantId },
  });
  if (!ingredient) throw new Error("Sirovina nije pronađena");

  const data: Prisma.IngredientUpdateInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("Naziv sirovine je obavezan");
    data.name = name;
  }
  if (input.unit !== undefined) {
    if (!ALL_UNITS.includes(input.unit)) throw new Error("Nepoznata jedinica mere");
    data.unit = input.unit;
  }
  if (input.category !== undefined) data.category = input.category?.trim() || null;
  if (input.sku !== undefined) data.sku = input.sku?.trim() || null;
  if (input.inventoryCategoryId !== undefined) {
    if (input.inventoryCategoryId) await assertOwnedActiveInventoryCategory(ctx, input.inventoryCategoryId);
    data.inventoryCategory = input.inventoryCategoryId
      ? { connect: { id: input.inventoryCategoryId } }
      : { disconnect: true };
  }

  const updated = await prisma.ingredient.update({ where: { id: ingredientId }, data });

  await recordAuditEntry(ctx, {
    entityType: "Ingredient",
    entityId: ingredientId,
    action: "ingredient.updated",
    previousValue: { name: ingredient.name, unit: ingredient.unit, category: ingredient.category, sku: ingredient.sku, inventoryCategoryId: ingredient.inventoryCategoryId },
    newValue: input,
  });

  return updated;
}

/**
 * Deaktivacija umesto brisanja — sirovina ostaje referencirana kroz istoriju
 * (IngredientMovement) i recepture (MenuItemIngredient), fizičko brisanje bi
 * ih osirotilo. Isti obrazac kao MenuItem/RestaurantTable deaktivacija.
 */
export async function deactivateIngredient(ctx: AuthContext, ingredientId: string) {
  requirePermission(ctx, "inventory.manage");
  const ingredient = await prisma.ingredient.findFirst({
    where: { id: ingredientId, restaurantId: ctx.restaurantId },
  });
  if (!ingredient) throw new Error("Sirovina nije pronađena");
  if (!ingredient.isActive) throw new Error("Sirovina je već deaktivirana");

  const updated = await prisma.ingredient.update({ where: { id: ingredientId }, data: { isActive: false } });

  await recordAuditEntry(ctx, {
    entityType: "Ingredient",
    entityId: ingredientId,
    action: "ingredient.deactivated",
    newValue: { name: ingredient.name },
  });
  return updated;
}

export async function activateIngredient(ctx: AuthContext, ingredientId: string) {
  requirePermission(ctx, "inventory.manage");
  const ingredient = await prisma.ingredient.findFirst({
    where: { id: ingredientId, restaurantId: ctx.restaurantId },
  });
  if (!ingredient) throw new Error("Sirovina nije pronađena");
  if (ingredient.isActive) throw new Error("Sirovina je već aktivna");

  const updated = await prisma.ingredient.update({ where: { id: ingredientId }, data: { isActive: true } });

  await recordAuditEntry(ctx, {
    entityType: "Ingredient",
    entityId: ingredientId,
    action: "ingredient.activated",
    newValue: { name: ingredient.name },
  });
  return updated;
}

export interface ListIngredientsFilter {
  search?: string;
  activeOnly?: boolean;
  /** Legacy free-text category field (kept for backward compat, unused by the P1.5 UI). */
  category?: string;
  /** P1.5: filter by an InventoryCategory id — matches that category OR any of its children (so filtering by "KUHINJA" also returns items filed under "KUHINJA > Meso" etc). */
  inventoryCategoryId?: string;
}

/**
 * Lista sirovina + (opciono) stanje na JEDNOJ lokaciji, u dva upita ukupno
 * bez obzira na broj sirovina — isti "batch, ne po-artiklu" obrazac kao
 * getStockStatusForMenuItems u inventory-service.ts. Uključuje
 * inventoryCategory (+ parent, radi KUHINJA/ŠANK oznake) u ISTOM upitu —
 * nema dodatne rundu po sirovini.
 */
export async function listIngredients(ctx: AuthContext, locationId: string | undefined, filter: ListIngredientsFilter = {}) {
  requirePermission(ctx, "inventory.view");
  if (locationId) requireLocationAccess(ctx, locationId);

  let categoryIdFilter: { in: string[] } | undefined;
  if (filter.inventoryCategoryId) {
    const children = await prisma.inventoryCategory.findMany({
      where: { restaurantId: ctx.restaurantId, parentId: filter.inventoryCategoryId },
      select: { id: true },
    });
    categoryIdFilter = { in: [filter.inventoryCategoryId, ...children.map((c) => c.id)] };
  }

  const ingredients = await prisma.ingredient.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      ...(filter.activeOnly ? { isActive: true } : {}),
      ...(filter.category ? { category: filter.category } : {}),
      ...(categoryIdFilter ? { inventoryCategoryId: categoryIdFilter } : {}),
      ...(filter.search ? { name: { contains: filter.search, mode: "insensitive" } } : {}),
    },
    include: { inventoryCategory: { include: { parent: true } } },
    orderBy: { name: "asc" },
  });

  if (!locationId || ingredients.length === 0) {
    return ingredients.map((i) => ({ ...i, stock: null }));
  }

  const stocks = await prisma.ingredientStock.findMany({
    where: { restaurantId: ctx.restaurantId, locationId, ingredientId: { in: ingredients.map((i) => i.id) } },
    select: { ingredientId: true, currentStock: true, lowStockThreshold: true },
  });
  const stockByIngredient = new Map(stocks.map((s) => [s.ingredientId, s]));

  return ingredients.map((i) => ({ ...i, stock: stockByIngredient.get(i.id) ?? null }));
}

export async function getIngredient(ctx: AuthContext, ingredientId: string) {
  requirePermission(ctx, "inventory.view");
  const ingredient = await prisma.ingredient.findFirst({
    where: { id: ingredientId, restaurantId: ctx.restaurantId },
  });
  if (!ingredient) throw new Error("Sirovina nije pronađena");
  return ingredient;
}

export async function getMovements(ctx: AuthContext, ingredientStockId: string, limit = 100) {
  requirePermission(ctx, "inventory.view");
  const stock = await prisma.ingredientStock.findFirst({
    where: { id: ingredientStockId, restaurantId: ctx.restaurantId },
  });
  if (!stock) throw new Error("Stanje sirovine nije pronađeno");
  requireLocationAccess(ctx, stock.locationId);

  const movements = await prisma.ingredientMovement.findMany({
    where: { ingredientStockId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const employeeIds = [...new Set(movements.flatMap((m) => (m.employeeId ? [m.employeeId] : [])))];
  const employees =
    employeeIds.length > 0
      ? await prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
  const nameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  return movements.map((m) => ({ ...m, employeeName: m.employeeId ? (nameById.get(m.employeeId) ?? null) : null }));
}

// ─── Stock setup / mutations ────────────────────────────────────────────────

/**
 * Inicijalizacija/postavljanje početnog stanja JEDNE sirovine na JEDNOJ
 * lokaciji — isti obrazac kao inventory-service.ts initializeTracking
 * (gated 'inventory.manage', ne stroža 'inventory.opening_stock', jer menja
 * tačno jednu stavku, ne masovnu operaciju).
 */
export async function initializeStock(
  ctx: AuthContext,
  input: { ingredientId: string; locationId: string; initialStock: number; lowStockThreshold?: number }
) {
  requirePermission(ctx, "inventory.manage");

  const ingredient = await prisma.ingredient.findFirst({
    where: { id: input.ingredientId, ...scopeToRestaurant(ctx) },
  });
  if (!ingredient) throw new Error("Sirovina nije pronađena");

  const location = await prisma.location.findFirst({
    where: { id: input.locationId, restaurantId: ctx.restaurantId },
  });
  if (!location) throw new Error("Lokacija nije pronađena");
  requireLocationAccess(ctx, location.id);

  if (input.initialStock < 0) throw new Error("Početno stanje ne može biti negativno");
  if (input.lowStockThreshold != null && input.lowStockThreshold < 0) {
    throw new Error("Prag niskog stanja ne može biti negativan");
  }

  const stock = await prisma.$transaction(async (tx) => {
    const existing = await tx.ingredientStock.findUnique({
      where: { locationId_ingredientId: { locationId: input.locationId, ingredientId: input.ingredientId } },
    });
    const item = existing
      ? await tx.ingredientStock.update({
          where: { id: existing.id },
          data: input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {},
        })
      : await tx.ingredientStock.create({
          data: {
            restaurantId: ctx.restaurantId,
            locationId: input.locationId,
            ingredientId: input.ingredientId,
            currentStock: input.initialStock,
            lowStockThreshold: input.lowStockThreshold ?? null,
          },
        });

    if (!existing && input.initialStock > 0) {
      await tx.ingredientMovement.create({
        data: {
          restaurantId: ctx.restaurantId,
          locationId: input.locationId,
          ingredientId: input.ingredientId,
          ingredientStockId: item.id,
          type: "OPENING_STOCK",
          quantityDelta: input.initialStock,
          quantityBefore: 0,
          quantityAfter: input.initialStock,
          employeeId: ctx.employeeId,
          reason: "Inicijalizacija početnog stanja sirovine",
        },
      });
    }
    return item;
  });

  await recordAuditEntry(ctx, {
    entityType: "IngredientStock",
    entityId: stock.id,
    action: "ingredient.stock_initialized",
    newValue: { ingredientId: input.ingredientId, locationId: input.locationId, initialStock: input.initialStock },
    locationId: input.locationId,
  });

  return stock;
}

export async function setLowStockThreshold(ctx: AuthContext, ingredientStockId: string, threshold: number | null) {
  requirePermission(ctx, "inventory.manage");
  if (threshold != null && threshold < 0) throw new Error("Prag niskog stanja ne može biti negativan");

  const stock = await prisma.ingredientStock.findFirst({
    where: { id: ingredientStockId, restaurantId: ctx.restaurantId },
  });
  if (!stock) throw new Error("Stanje sirovine nije pronađeno");
  requireLocationAccess(ctx, stock.locationId);

  return prisma.ingredientStock.update({ where: { id: ingredientStockId }, data: { lowStockThreshold: threshold } });
}

export async function receiveStock(ctx: AuthContext, ingredientStockId: string, input: { quantity: number; reason?: string }) {
  requirePermission(ctx, "inventory.manage");
  if (input.quantity <= 0) throw new Error("Količina mora biti pozitivna");

  const updated = await applyDelta(ctx, ingredientStockId, input.quantity, "RECEIPT", {
    employeeId: ctx.employeeId,
    reason: input.reason ?? "Prijem robe",
  });

  await recordAuditEntry(ctx, {
    entityType: "IngredientStock",
    entityId: ingredientStockId,
    action: "ingredient.receipt",
    newValue: { quantity: input.quantity, after: Number(updated.after) },
    locationId: updated.locationId,
  });
  return updated;
}

export async function adjustStock(ctx: AuthContext, ingredientStockId: string, input: { delta: number; reason: string }) {
  requirePermission(ctx, "inventory.manage");
  if (input.delta === 0) throw new Error("Delta korekcije ne može biti nula");
  if (!input.reason.trim()) throw new Error("Razlog korekcije je obavezan");

  const updated = await applyDelta(ctx, ingredientStockId, input.delta, "ADJUSTMENT", {
    employeeId: ctx.employeeId,
    reason: input.reason,
  });

  await recordAuditEntry(ctx, {
    entityType: "IngredientStock",
    entityId: ingredientStockId,
    action: "ingredient.adjustment",
    newValue: { delta: input.delta, reason: input.reason, after: Number(updated.after) },
    locationId: updated.locationId,
  });
  return updated;
}

export async function writeOffStock(ctx: AuthContext, ingredientStockId: string, input: { quantity: number; reason: string }) {
  requirePermission(ctx, "inventory.manage");
  if (input.quantity <= 0) throw new Error("Količina mora biti pozitivna");
  if (!input.reason.trim()) throw new Error("Razlog otpisa je obavezan");

  const updated = await applyDelta(ctx, ingredientStockId, -input.quantity, "WRITE_OFF", {
    employeeId: ctx.employeeId,
    reason: input.reason,
  });

  await recordAuditEntry(ctx, {
    entityType: "IngredientStock",
    entityId: ingredientStockId,
    action: "ingredient.write_off",
    newValue: { quantity: input.quantity, reason: input.reason, after: Number(updated.after) },
    locationId: updated.locationId,
  });
  return updated;
}

// ─── Internal helper ────────────────────────────────────────────────────────

/**
 * Atomični uslovni UPDATE (ista tehnika kao inventory-service.ts
 * _applyDelta) — WHERE klauzula sprečava negativno stanje i istovremeno
 * zatvara konkurentnu trku: dva paralelna zahteva nad ISTIM redom se
 * serijalizuju kroz Postgres-ovo row-level zaključavanje, drugi vidi već
 * committed rezultat prvog. `quantity >= 0` je tvrdo pravilo ove faze
 * (specifikacija #16) — nema posebne "dozvoljene" korekcije ispod nule.
 */
async function applyDelta(
  ctx: AuthContext,
  ingredientStockId: string,
  delta: number,
  type: "RECEIPT" | "ADJUSTMENT" | "WRITE_OFF",
  meta: { employeeId: string; reason: string }
) {
  const accessible = await prisma.ingredientStock.findFirst({
    where: { id: ingredientStockId, restaurantId: ctx.restaurantId, locationId: { in: ctx.locationIds } },
    select: { id: true },
  });
  if (!accessible) throw new Error("Stanje sirovine nije pronađeno");

  return prisma.$transaction(async (tx) => {
    type UpdatedRow = {
      id: string;
      restaurantId: string;
      locationId: string;
      ingredientId: string;
      currentStock: string;
    };
    const rows = await tx.$queryRaw<UpdatedRow[]>`
      UPDATE ingredient_stocks
      SET "currentStock" = "currentStock" + ${delta}::numeric
      WHERE id = ${ingredientStockId}
        AND "restaurantId" = ${ctx.restaurantId}
        AND "currentStock" + ${delta}::numeric >= 0
      RETURNING id, "restaurantId", "locationId", "ingredientId", "currentStock"
    `;
    const updated = rows[0];
    if (!updated) {
      const stock = await tx.ingredientStock.findFirst({
        where: { id: ingredientStockId, restaurantId: ctx.restaurantId },
        select: { currentStock: true },
      });
      if (!stock) throw new Error("Stanje sirovine nije pronađeno");
      throw new Error(
        `Promena bi dovela do negativnog stanja (trenutno: ${stock.currentStock}). Maksimalno umanjenje: ${stock.currentStock}.`
      );
    }

    const after = Number(updated.currentStock);
    const before = after - delta;
    const movement = await tx.ingredientMovement.create({
      data: {
        restaurantId: ctx.restaurantId,
        locationId: updated.locationId,
        ingredientId: updated.ingredientId,
        ingredientStockId,
        type,
        quantityDelta: delta,
        quantityBefore: before,
        quantityAfter: after,
        employeeId: meta.employeeId,
        reason: meta.reason,
      },
    });
    return { stock: updated, movement, before, after, locationId: updated.locationId };
  });
}

// ─── P1.2: automatsko skidanje po normativu (SALE) ─────────────────────────

/**
 * Autoritativna tačka potrošnje sirovina — poziva se ISKLJUČIVO iz
 * billing-service.ts/completePayment, UNUTAR VEĆ POSTOJEĆE
 * `prisma.$transaction`, odmah pored (istog stila kao)
 * `validateAndDecrementInventoryInTx` za gotove artikle. Ako ova funkcija
 * baci grešku, CELA naplatna transakcija se rollback-uje (Payment/Receipt/
 * sto/OrderEvent) — nikad ne postoji stanje "naplata uspela, sirovine nisu
 * skinute" ili obrnuto, jer je sve JEDNA atomska transakcija.
 *
 * Redosled (namerno, radi tačnosti i bezbednosti):
 *  1. Agregacija tražene količine PO SIROVINI preko SVIH prodatih stavki
 *     (više artikala može deliti istu sirovinu — P1.2 §5).
 *  2. Artikli BEZ recepture se tiho preskaču (P1.2 §12) — ne postoji
 *     "delimično definisana receptura" greška, samo artikli sa definisanom
 *     recepturom učestvuju.
 *  3. Idempotency: sirovine koje VEĆ imaju SALE kretanje za ovaj paymentId
 *     (@@unique(paymentId, ingredientId) na IngredientMovement) se
 *     preskaču — bezbedno za slučaj da se ova funkcija ikad pozove više
 *     puta za isti payment (odbrana u dubinu; primarna zaštita od duple
 *     naplate je already-COMPLETED guard u completePayment-u).
 *  4. READ-ONLY provera SVIH preostalih potrebnih sirovina PRE bilo kakve
 *     mutacije (P1.2 §8/§20) — ako bilo koja nedostaje, baca JEDNU
 *     InsufficientIngredientStockError sa KOMPLETNIM spiskom nedostataka;
 *     ništa se ne menja (nijedna sirovina, čak ni one koje IMAJU dovoljno
 *     stanja).
 *  5. Tek posle uspešne provere: atomični uslovni UPDATE po sirovini (ista
 *     tehnika kao applyDelta/validateAndDecrementInventoryInTx) — ovo je
 *     STVARNA odbrana od konkurentnosti (koraci 4 su samo UX/rana provera;
 *     dve paralelne transakcije i dalje mogu proći korak 4 istovremeno, pa
 *     korak 5 mora nezavisno da spreči negativno stanje).
 *
 * Konverzija jedinica: NIJE potrebna. Receptura (MenuItemIngredient.quantity)
 * je po dizajnu foundation faze UVEK izražena u jedinici same sirovine
 * (Ingredient.unit) — nema po-recepturi override jedinice — pa je količina iz
 * recepture direktno uporediva/oduzimljiva od IngredientStock.currentStock
 * bez ikakve konverzije (vidi napomenu u schema.prisma uz MenuItemIngredient
 * i unit-of-measure.ts).
 *
 * Istorijska tačnost: quantityDelta/Before/After na svakom IngredientMovement
 * redu su IZRAČUNATI I UPISANI U TRENUTKU PRODAJE iz recepture kakva je TADA
 * bila — kasnija izmena recepture (MenuItemIngredient.quantity) nikad ne menja
 * već upisane redove (nema UPDATE-a, samo INSERT). Kretanje samo po sebi je
 * kompletan istorijski zapis — nije potrebna posebna "recipe snapshot"
 * tabela.
 */
interface IngredientRequirement {
  ingredientId: string;
  name: string;
  unit: UnitOfMeasure;
  required: Prisma.Decimal;
}

/**
 * P1.6: koji od datih MenuItemId-jeva su TRENUTNO konfigurisani na RECIPE
 * metodu praćenja (jedini autoritativni gate — vidi inventory-service.ts
 * InventoryTrackingMethod napomenu). Zamenjuje raniju "ima bar jednu liniju
 * recepture" proveru (koja je mešala "konfigurisan" i "ima istorijske
 * linije") — ove dve funkcije zajedno (ova + getConfiguredMenuItemIds ispod)
 * razlikuju "RECIPE mod, ali 0 linija" (RecipeNotConfiguredError) od
 * "RECIPE mod sa definisanom recepturom" (normalna provera zaliha).
 */
async function getRecipeTrackedMenuItems(
  db: Prisma.TransactionClient | typeof prisma,
  restaurantId: string,
  menuItemIds: string[]
): Promise<Array<{ id: string; name: string }>> {
  if (menuItemIds.length === 0) return [];
  return db.menuItem.findMany({
    where: { id: { in: menuItemIds }, restaurantId, inventoryTrackingMethod: "RECIPE" },
    select: { id: true, name: true },
  });
}

/** Batch provera: koji od datih MenuItemId-jeva TRENUTNO imaju bar jednu liniju recepture. */
async function getConfiguredMenuItemIds(
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

/**
 * P1.6: filtrira dati qtyByMenuItem SAMO na artikle koji su TRENUTNO u
 * RECIPE modu, i baca RecipeNotConfiguredError ako bilo koji od njih nema
 * ijednu liniju recepture. KRITIČNO: computeRequiredIngredients sam po sebi
 * NE zna ništa o inventoryTrackingMethod (samo čita MenuItemIngredient
 * redove) — pozivalac MORA proći kroz OVU funkciju prvo, inače bi zaostala
 * MenuItemIngredient linija (npr. posle RECIPE -> NO_TRACKING/DIRECT_STOCK
 * prelaska, koji NAMERNO ne briše recepturu) tiho nastavila da odbija
 * sirovine iako artikal više NIJE u RECIPE modu.
 */
async function filterToConfiguredRecipeItems(
  db: Prisma.TransactionClient | typeof prisma,
  restaurantId: string,
  qtyByMenuItem: Map<string, number>
): Promise<Map<string, number>> {
  const recipeItems = await getRecipeTrackedMenuItems(db, restaurantId, [...qtyByMenuItem.keys()]);
  if (recipeItems.length === 0) return new Map();

  const configuredIds = await getConfiguredMenuItemIds(db, recipeItems.map((i) => i.id));
  const unconfigured = recipeItems.filter((i) => !configuredIds.has(i.id));
  if (unconfigured.length > 0) {
    throw new RecipeNotConfiguredError(unconfigured.map((i) => ({ menuItemId: i.id, name: i.name })));
  }

  const recipeIds = new Set(recipeItems.map((i) => i.id));
  return new Map([...qtyByMenuItem].filter(([id]) => recipeIds.has(id)));
}

/**
 * Agregira potrebnu količinu PO SIROVINI preko datog skupa (menuItemId ->
 * tražena količina artikla), iz TRENUTNE recepture (MenuItemIngredient) —
 * jedan upit bez obzira na broj artikala. Deljena osnova za
 * validateAndDecrementIngredientsInTx (naplata) I assertIngredientStockAvailable
 * (predpregled/submit) — ISTA matematika na oba mesta, namerno (P1.4).
 *
 * Artikli bez recepture (nema redova) se tiho ne pojavljuju u rezultatu —
 * ne postoji "delimično definisana receptura" greška ovde (to je posao
 * assertRecipesConfigured iznad, koji SE MORA pozvati PRE ove funkcije za
 * RECIPE-mod artikle). Neaktivna sirovina i dalje učestvuje ako je već u
 * recepturi (P1.2 §13) — deaktivacija sprečava NOVU upotrebu, ne menja
 * postojeće recepture koje je već referenciraju.
 */
async function computeRequiredIngredients(
  db: Prisma.TransactionClient | typeof prisma,
  qtyByMenuItem: Map<string, number>
): Promise<Map<string, IngredientRequirement>> {
  const requiredByIngredient = new Map<string, IngredientRequirement>();
  if (qtyByMenuItem.size === 0) return requiredByIngredient;

  const recipeLines = await db.menuItemIngredient.findMany({
    where: { menuItemId: { in: [...qtyByMenuItem.keys()] } },
    include: { ingredient: true },
  });

  for (const line of recipeLines) {
    const qty = qtyByMenuItem.get(line.menuItemId);
    if (!qty) continue;
    const need = new Prisma.Decimal(line.quantity).mul(qty);
    const existing = requiredByIngredient.get(line.ingredientId);
    if (existing) {
      existing.required = existing.required.add(need);
    } else {
      requiredByIngredient.set(line.ingredientId, {
        ingredientId: line.ingredientId,
        name: line.ingredient.name,
        unit: line.ingredient.unit,
        required: need,
      });
    }
  }
  return requiredByIngredient;
}

/**
 * Read-only provera nedostataka za dati skup potreba naspram
 * IngredientStock — jedan upit bez obzira na broj sirovina. NIKAD ne
 * mutira. Deljeno između validateAndDecrementIngredientsInTx (korak 4, PRE
 * mutacije) i assertIngredientStockAvailable (kompletna provera).
 */
async function findIngredientShortages(
  db: Prisma.TransactionClient | typeof prisma,
  restaurantId: string,
  locationId: string,
  requiredByIngredient: Map<string, IngredientRequirement>
) {
  const ingredientIds = [...requiredByIngredient.keys()];
  const stocks =
    ingredientIds.length > 0
      ? await db.ingredientStock.findMany({
          where: { restaurantId, locationId, ingredientId: { in: ingredientIds } },
        })
      : [];
  const stockByIngredient = new Map(stocks.map((s) => [s.ingredientId, s]));

  const shortages: Array<{ name: string; available: string; required: string; unit: UnitOfMeasure }> = [];
  for (const req of requiredByIngredient.values()) {
    const stock = stockByIngredient.get(req.ingredientId);
    const available = stock ? new Prisma.Decimal(stock.currentStock) : new Prisma.Decimal(0);
    if (available.lessThan(req.required)) {
      shortages.push({ name: req.name, available: available.toString(), required: req.required.toString(), unit: req.unit });
    }
  }
  return { shortages, stockByIngredient };
}

export async function validateAndDecrementIngredientsInTx(
  tx: Prisma.TransactionClient,
  input: {
    paymentId: string;
    orderId: string;
    restaurantId: string;
    locationId: string;
    items: Array<{ menuItemId: string | null; quantity: number }>;
  }
): Promise<void> {
  const soldQtyByMenuItem = new Map<string, number>();
  for (const it of input.items) {
    if (!it.menuItemId) continue;
    soldQtyByMenuItem.set(it.menuItemId, (soldQtyByMenuItem.get(it.menuItemId) ?? 0) + it.quantity);
  }
  if (soldQtyByMenuItem.size === 0) return;

  // P1.6: filtrira SAMO na RECIPE-mod artikle (baca RecipeNotConfiguredError
  // pre bilo kakve mutacije ako je neki od njih bez ijedne linije recepture
  // — "Normativ nije podešen"). Zaostala MenuItemIngredient linija na
  // artiklu koji je u međuvremenu prešao na DIRECT_STOCK/NO_TRACKING se
  // OVDE isključuje iz odbitka, ne u computeRequiredIngredients.
  const recipeQtyByMenuItem = await filterToConfiguredRecipeItems(tx, input.restaurantId, soldQtyByMenuItem);
  if (recipeQtyByMenuItem.size === 0) return;

  const requiredByIngredient = await computeRequiredIngredients(tx, recipeQtyByMenuItem);
  if (requiredByIngredient.size === 0) return; // nijedan prodat artikal nema definisan normativ

  // Idempotency: preskoči sirovine koje već imaju SALE kretanje za OVAJ
  // paymentId (defense-in-depth — vidi napomenu iznad funkcije).
  const alreadyProcessed = await tx.ingredientMovement.findMany({
    where: { paymentId: input.paymentId, ingredientId: { in: [...requiredByIngredient.keys()] } },
    select: { ingredientId: true },
  });
  for (const row of alreadyProcessed) {
    requiredByIngredient.delete(row.ingredientId);
  }
  if (requiredByIngredient.size === 0) return; // sve već obrađeno za ovaj payment (retry no-op)

  // Korak 4 — read-only provera SVIH sirovina PRE bilo kakve mutacije.
  const { shortages, stockByIngredient } = await findIngredientShortages(tx, input.restaurantId, input.locationId, requiredByIngredient);
  if (shortages.length > 0) {
    throw new InsufficientIngredientStockError(shortages);
  }

  // Korak 5 — stvarna, konkurentnost-bezbedna mutacija. Svaka sirovina
  // garantovano ima stock red ovde (inače bi korak 4 već bacio grešku).
  for (const req of requiredByIngredient.values()) {
    const stock = stockByIngredient.get(req.ingredientId)!;
    const requiredStr = req.required.toString();

    type Row = { currentStock: string };
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE ingredient_stocks
      SET "currentStock" = "currentStock" - ${requiredStr}::numeric
      WHERE id = ${stock.id}
        AND "currentStock" >= ${requiredStr}::numeric
      RETURNING "currentStock"
    `;

    if (rows.length === 0) {
      // Izgubljena trka NAKON koraka 4 (redak slučaj prave konkurentnosti) —
      // izveštava se kao nedovoljno stanje za OVU sirovinu.
      const current = await tx.ingredientStock.findUnique({
        where: { id: stock.id },
        select: { currentStock: true },
      });
      throw new InsufficientIngredientStockError([
        {
          name: req.name,
          available: (current?.currentStock ?? new Prisma.Decimal(0)).toString(),
          required: requiredStr,
          unit: req.unit,
        },
      ]);
    }

    const after = new Prisma.Decimal(rows[0].currentStock);
    const before = after.add(req.required);

    await tx.ingredientMovement.create({
      data: {
        restaurantId: input.restaurantId,
        locationId: input.locationId,
        ingredientId: req.ingredientId,
        ingredientStockId: stock.id,
        type: "SALE",
        quantityDelta: req.required.neg(),
        quantityBefore: before,
        quantityAfter: after,
        paymentId: input.paymentId,
        orderId: input.orderId,
        reason: "Prodaja — automatsko skidanje po normativu",
      },
    });
  }
}

/**
 * Samostalna verzija (sopstvena transakcija) — zadržana za direktno
 * testiranje idempotentnosti/konkurentnosti van punog completePayment toka,
 * isti obrazac kao inventory-service.ts decrementOnSale.
 */
export async function decrementIngredientsOnSale(input: {
  paymentId: string;
  orderId: string;
  restaurantId: string;
  locationId: string;
  items: Array<{ menuItemId: string | null; quantity: number }>;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await validateAndDecrementIngredientsInTx(tx, input);
  });
}

// ─── P1.4: Waiter availability — recipe-produced items ─────────────────────

export interface IngredientAvailabilityRequirement {
  menuItemId: string;
  name: string;
  quantity: number;
}

/**
 * Read-only pre-check — the ingredient/recipe-side twin of
 * inventory-service.ts assertStockAvailable, called ALONGSIDE it (not
 * instead of) from order-service.ts addItem/updateItem/submitOrder. NEVER
 * mutates IngredientStock — that remains exclusively
 * validateAndDecrementIngredientsInTx's job at Payment (P1.4 requirement:
 * do not move deduction earlier).
 *
 * Aggregates by menuItemId FIRST (same reason as assertStockAvailable: two
 * lines of the same item with different modifiers must sum before
 * checking), then computeRequiredIngredients aggregates AGAIN by
 * ingredient across every recipe-produced item in the requirement set —
 * two different menu items sharing an ingredient (e.g. Omlet + Omlet sa
 * sirom both needing eggs) correctly combine into one demand figure
 * instead of being checked independently against the same starting stock.
 *
 * Items with no configured recipe are silently absent from
 * computeRequiredIngredients's result — this function only ever concerns
 * itself with recipe-governed items, symmetric with the double-deduction
 * defense in inventory-service.ts (a configured recipe always wins, and
 * conversely direct-stock items are never touched here).
 */
export async function assertIngredientStockAvailable(
  db: Prisma.TransactionClient | typeof prisma,
  input: { restaurantId: string; locationId: string; requirements: IngredientAvailabilityRequirement[] }
): Promise<void> {
  const qtyByMenuItem = new Map<string, number>();
  for (const r of input.requirements) {
    qtyByMenuItem.set(r.menuItemId, (qtyByMenuItem.get(r.menuItemId) ?? 0) + r.quantity);
  }
  if (qtyByMenuItem.size === 0) return;

  // P1.6: filter down to RECIPE-mode items only (blocks early — same
  // RecipeNotConfiguredError rule as payment, surfaced sooner so the
  // waiter never even gets to submit it) — see filterToConfiguredRecipeItems
  // for why this filter, not computeRequiredIngredients, is the real gate.
  const recipeQtyByMenuItem = await filterToConfiguredRecipeItems(db, input.restaurantId, qtyByMenuItem);
  if (recipeQtyByMenuItem.size === 0) return;

  const requiredByIngredient = await computeRequiredIngredients(db, recipeQtyByMenuItem);
  if (requiredByIngredient.size === 0) return; // none of these items has a configured recipe

  const { shortages } = await findIngredientShortages(db, input.restaurantId, input.locationId, requiredByIngredient);
  if (shortages.length > 0) {
    throw new InsufficientIngredientStockError(shortages);
  }
}

export type RecipeAvailabilityStatus = "AVAILABLE" | "LOW" | "OUT";

export interface RecipeAvailabilityInfo {
  status: RecipeAvailabilityStatus;
  /** floor(min over recipe lines of currentStock / lineQuantity), never negative. */
  availablePortions: number;
  /** Name of the ingredient constraining availablePortions — always set when the item has a configured recipe. */
  limitingIngredientName: string | null;
  /**
   * P1.6: false when the item is in RECIPE tracking mode but has ZERO
   * configured recipe lines ("Normativ nije podešen") — a distinct reason
   * for OUT from ordinary "insufficient ingredients", so the UI can show
   * different wording (Waiter: "Normativ nije podešen" vs. "Nema dovoljno
   * sirovina — <ingredient>"). Always true when the item has at least one
   * recipe line.
   */
  configured: boolean;
}

/**
 * Batch-computes DISPLAY availability (menu badges) for RECIPE-tracked
 * items among the given MenuItemIds at ONE location — three queries total
 * regardless of item count (which items are RECIPE-mode, their recipe
 * lines, then ingredient stocks), matching the existing
 * getStockStatusForMenuItems "batch, not per-item" pattern. This is
 * advisory display data only — it answers "how many portions could I sell
 * right now", NOT a specific requested quantity (that's
 * assertIngredientStockAvailable's job).
 *
 * Only MenuItemIds whose inventoryTrackingMethod is currently RECIPE appear
 * in the returned map — DIRECT_STOCK/NO_TRACKING items are simply absent,
 * and the caller (menu-service.ts listMenuItems) treats "no entry" as "not
 * recipe-governed", the same convention getStockStatusForMenuItems already
 * uses for non-DIRECT_STOCK items.
 *
 * LOW status reuses the ALREADY-EXISTING IngredientStock.lowStockThreshold
 * (the same field the Sirovine admin page already surfaces) on the
 * limiting ingredient — deliberately not an invented portions-count
 * threshold, per the explicit instruction to reuse a real mechanism or
 * skip LOW rather than guess one.
 */
export async function getRecipeAvailabilityForMenuItems(
  restaurantId: string,
  locationId: string,
  menuItemIds: string[]
): Promise<Map<string, RecipeAvailabilityInfo>> {
  const result = new Map<string, RecipeAvailabilityInfo>();
  if (menuItemIds.length === 0) return result;

  const recipeItemIds = (await getRecipeTrackedMenuItems(prisma, restaurantId, menuItemIds)).map((i) => i.id);
  if (recipeItemIds.length === 0) return result;

  const recipeLines = await prisma.menuItemIngredient.findMany({
    where: { menuItemId: { in: recipeItemIds } },
    include: { ingredient: true },
  });

  const linesByMenuItem = new Map<string, typeof recipeLines>();
  for (const line of recipeLines) {
    const list = linesByMenuItem.get(line.menuItemId) ?? [];
    list.push(line);
    linesByMenuItem.set(line.menuItemId, list);
  }

  const ingredientIds = [...new Set(recipeLines.map((l) => l.ingredientId))];
  const stocks =
    ingredientIds.length > 0
      ? await prisma.ingredientStock.findMany({
          where: { restaurantId, locationId, ingredientId: { in: ingredientIds } },
        })
      : [];
  const stockByIngredient = new Map(stocks.map((s) => [s.ingredientId, s]));

  for (const menuItemId of recipeItemIds) {
    const lines = linesByMenuItem.get(menuItemId);
    if (!lines || lines.length === 0) {
      result.set(menuItemId, { status: "OUT", availablePortions: 0, limitingIngredientName: null, configured: false });
      continue;
    }

    let availablePortions = Infinity;
    let limitingName: string | null = null;
    let limitingIsLow = false;
    for (const line of lines) {
      const stock = stockByIngredient.get(line.ingredientId);
      const available = stock ? new Prisma.Decimal(stock.currentStock) : new Prisma.Decimal(0);
      const perPortion = new Prisma.Decimal(line.quantity);
      const possible = Math.floor(available.div(perPortion).toNumber());
      if (possible < availablePortions) {
        availablePortions = possible;
        limitingName = line.ingredient.name;
        const threshold = stock?.lowStockThreshold != null ? new Prisma.Decimal(stock.lowStockThreshold) : null;
        limitingIsLow = threshold != null && available.lessThanOrEqualTo(threshold);
      }
    }
    availablePortions = Math.max(0, availablePortions);
    const status: RecipeAvailabilityStatus = availablePortions <= 0 ? "OUT" : limitingIsLow ? "LOW" : "AVAILABLE";
    result.set(menuItemId, { status, availablePortions, limitingIngredientName: limitingName, configured: true });
  }

  return result;
}
