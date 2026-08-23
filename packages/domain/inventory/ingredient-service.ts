/**
 * P1: Normativi/sirovine — sirovinski lager (Ingredient/IngredientStock/
 * IngredientMovement). NAMERNO potpuno odvojeno od inventory-service.ts
 * (koji prati gotov MenuItem "na stanju") — vidi napomenu na vrhu te
 * sekcije u schema.prisma. Isti obrasci (atomični uslovni UPDATE za
 * konkurentnost, ledger uz svaku promenu, requirePermission/
 * requireLocationAccess/scopeToRestaurant, recordAuditEntry) su namerno
 * ponovo iskorišćeni odavde — dokazano ispravni, nema razloga za novi stil.
 *
 * VAŽNO (ova faza): NIJEDNA funkcija ovde ne piše "SALE" IngredientMovement
 * i ništa ovde se ne poziva iz billing-service.ts/completePayment. Recepture
 * (recipe-service.ts) postoje i mogu se definisati, ali prodaja ih JOŠ NE
 * troši automatski — to je posebna, kasnija, eksplicitno odobrena faza.
 */
import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { ALL_UNITS, type UnitOfMeasure } from "./unit-of-measure";

// ─── Create / read ──────────────────────────────────────────────────────────

export interface CreateIngredientInput {
  name: string;
  unit: UnitOfMeasure;
  category?: string;
  sku?: string;
}

export async function createIngredient(ctx: AuthContext, input: CreateIngredientInput) {
  requirePermission(ctx, "inventory.manage");

  const name = input.name.trim();
  if (!name) throw new Error("Naziv sirovine je obavezan");
  if (name.length > 120) throw new Error("Naziv sirovine je predugačak (max 120 znakova)");
  if (!ALL_UNITS.includes(input.unit)) throw new Error("Nepoznata jedinica mere");

  const ingredient = await prisma.ingredient.create({
    data: {
      restaurantId: ctx.restaurantId,
      name,
      unit: input.unit,
      category: input.category?.trim() || null,
      sku: input.sku?.trim() || null,
    },
  });

  await recordAuditEntry(ctx, {
    entityType: "Ingredient",
    entityId: ingredient.id,
    action: "ingredient.created",
    newValue: { name, unit: input.unit, category: input.category, sku: input.sku },
  });

  return ingredient;
}

export interface UpdateIngredientInput {
  name?: string;
  unit?: UnitOfMeasure;
  category?: string | null;
  sku?: string | null;
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

  const updated = await prisma.ingredient.update({ where: { id: ingredientId }, data });

  await recordAuditEntry(ctx, {
    entityType: "Ingredient",
    entityId: ingredientId,
    action: "ingredient.updated",
    previousValue: { name: ingredient.name, unit: ingredient.unit, category: ingredient.category, sku: ingredient.sku },
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
  category?: string;
}

/**
 * Lista sirovina + (opciono) stanje na JEDNOJ lokaciji, u dva upita ukupno
 * bez obzira na broj sirovina — isti "batch, ne po-artiklu" obrazac kao
 * getStockStatusForMenuItems u inventory-service.ts.
 */
export async function listIngredients(ctx: AuthContext, locationId: string | undefined, filter: ListIngredientsFilter = {}) {
  requirePermission(ctx, "inventory.view");
  if (locationId) requireLocationAccess(ctx, locationId);

  const ingredients = await prisma.ingredient.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      ...(filter.activeOnly ? { isActive: true } : {}),
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.search ? { name: { contains: filter.search, mode: "insensitive" } } : {}),
    },
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
