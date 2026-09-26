/**
 * PROMOTIONS & PRICING ENGINE V1.
 *
 * ONE authoritative, server-side pricing resolver — reused by order-service
 * (addItem / submitOrder re-snapshot) and by the waiter Menu Snapshot (for
 * instant client-side preview, via the raw rule set + the shared pure
 * evaluator in packages/shared/promotion-schedule.ts, never a duplicated
 * evaluation algorithm). The client can PREVIEW a promo price; it can never
 * be the authority — resolveEffectivePrice below always re-derives the
 * price server-side from Promotion rows + the live MenuItem base price,
 * exactly like the pre-existing base-price re-snapshot in
 * order-service.ts's submitOrder already does for plain price changes.
 *
 * SNAPSHOT DISCIPLINE: this module NEVER writes to OrderItem directly —
 * order-service.ts calls resolveEffectivePrice() and freezes the result
 * onto the OrderItem row itself (regularPrice/price/promotionId/
 * promotionName/promotionType/promotionValue). Editing, deactivating, or
 * deleting a Promotion row here can NEVER retroactively change an
 * already-snapshotted OrderItem — see schema.prisma's Promotion doc comment.
 *
 * NO STACKING (spec section 12): resolveEffectivePrice always resolves to
 * AT MOST one winning promotion per line, via the shared, deterministic
 * pickWinningPromotion (explicit item-target beats category-target, then
 * priority, then earliest-created, then id) — never sums multiple discounts.
 */
import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { invalidateMenuSnapshotCache } from "../menu/menu-service";
import {
  pickWinningPromotion,
  type PromotionCandidate,
  type PromotionScheduleRule,
  type CreatePromotionInput,
  type UpdatePromotionInput,
} from "@rcs/shared";

const PROMOTIONS_VIEW = "promotions.view";
const PROMOTIONS_MANAGE = "promotions.manage";

type PromotionRow = {
  id: string;
  name: string;
  type: "PERCENTAGE_DISCOUNT" | "FIXED_PRICE";
  value: Prisma.Decimal;
  priority: number;
  createdAt: Date;
  daysOfWeek: number[];
  startTime: number;
  endTime: number;
  startDate: Date | null;
  endDate: Date | null;
};

function toScheduleRule(row: PromotionRow): PromotionScheduleRule {
  return {
    daysOfWeek: row.daysOfWeek,
    startTime: row.startTime,
    endTime: row.endTime,
    startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
    endDate: row.endDate ? row.endDate.toISOString().slice(0, 10) : null,
  };
}

const PROMOTION_INCLUDE = {
  targets: {
    include: {
      menuItem: { select: { id: true, name: true } },
      category: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.PromotionInclude;

function auditSnapshot(row: Prisma.PromotionGetPayload<{ include: typeof PROMOTION_INCLUDE }>) {
  return {
    name: row.name, description: row.description, locationId: row.locationId,
    type: row.type, value: row.value.toString(), isActive: row.isActive, priority: row.priority,
    ...toScheduleRule(row),
    targets: {
      menuItemIds: row.targets.flatMap(t => t.menuItemId ? [t.menuItemId] : []).sort(),
      categoryIds: row.targets.flatMap(t => t.categoryId ? [t.categoryId] : []).sort(),
    },
  };
}

// Prisma DateTime inputs require an instant even for a PostgreSQL DATE column.
// UTC midnight preserves the entered calendar date; scheduling still uses Restaurant.timezone.
const calendarDate = (date: string | null | undefined) => date ? new Date(`${date}T00:00:00.000Z`) : null;

export async function listPromotions(ctx: AuthContext, options?: { includeArchived?: boolean }) {
  requirePermission(ctx, PROMOTIONS_VIEW);
  return prisma.promotion.findMany({
    where: { ...scopeToRestaurant(ctx), archivedAt: options?.includeArchived ? undefined : null },
    include: PROMOTION_INCLUDE,
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
  });
}

export async function getPromotion(ctx: AuthContext, id: string) {
  requirePermission(ctx, PROMOTIONS_VIEW);
  const promotion = await prisma.promotion.findFirst({ where: { id, ...scopeToRestaurant(ctx) }, include: PROMOTION_INCLUDE });
  if (!promotion) throw new Error("Promocija nije pronađena");
  return promotion;
}

async function validateTargets(ctx: AuthContext, targets: { menuItemIds: string[]; categoryIds: string[] }): Promise<void> {
  if (targets.menuItemIds.length > 0) {
    const count = await prisma.menuItem.count({ where: { id: { in: targets.menuItemIds }, restaurantId: ctx.restaurantId } });
    if (count !== new Set(targets.menuItemIds).size) throw new Error("Jedan ili više izabranih artikala nije pronađeno");
  }
  if (targets.categoryIds.length > 0) {
    const count = await prisma.menuCategory.count({ where: { id: { in: targets.categoryIds }, restaurantId: ctx.restaurantId } });
    if (count !== new Set(targets.categoryIds).size) throw new Error("Jedna ili više izabranih kategorija nije pronađeno");
  }
}

function targetCreateRows(targets: { menuItemIds: string[]; categoryIds: string[] }) {
  return [
    ...[...new Set(targets.menuItemIds)].map((menuItemId) => ({ targetType: "MENU_ITEM" as const, menuItemId })),
    ...[...new Set(targets.categoryIds)].map((categoryId) => ({ targetType: "MENU_CATEGORY" as const, categoryId })),
  ];
}

export async function createPromotion(ctx: AuthContext, input: CreatePromotionInput) {
  requirePermission(ctx, PROMOTIONS_MANAGE);
  if (input.locationId) requireLocationAccess(ctx, input.locationId);
  await validateTargets(ctx, input.targets);

  const promotion = await prisma.$transaction(async (tx) => {
    const created = await tx.promotion.create({
      data: {
        restaurantId: ctx.restaurantId,
        locationId: input.locationId ?? null,
        name: input.name,
        description: input.description ?? null,
        isActive: input.isActive,
        type: input.type,
        value: input.value,
        startDate: calendarDate(input.startDate),
        endDate: calendarDate(input.endDate),
        daysOfWeek: input.daysOfWeek,
        startTime: input.startTime,
        endTime: input.endTime,
        priority: input.priority,
        createdBy: ctx.employeeId,
        updatedBy: ctx.employeeId,
        targets: { createMany: { data: targetCreateRows(input.targets) } },
      },
      include: PROMOTION_INCLUDE,
    });
    await recordAuditEntry(
      ctx,
      {
        entityType: "Promotion",
        entityId: created.id,
        action: "promotion.created",
        newValue: auditSnapshot(created),
        locationId: input.locationId ?? undefined,
        category: "promotion",
      },
      tx
    );
    return created;
  });

  await invalidateMenuSnapshotCache(ctx.restaurantId);
  return promotion;
}

export async function updatePromotion(ctx: AuthContext, id: string, input: UpdatePromotionInput) {
  requirePermission(ctx, PROMOTIONS_MANAGE);
  const existing = await prisma.promotion.findFirst({ where: { id, ...scopeToRestaurant(ctx) }, include: PROMOTION_INCLUDE });
  if (!existing) throw new Error("Promocija nije pronađena");
  if (input.locationId) requireLocationAccess(ctx, input.locationId);
  await validateTargets(ctx, input.targets);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.promotionTarget.deleteMany({ where: { promotionId: id } });
    const result = await tx.promotion.update({
      where: { id },
      data: {
        locationId: input.locationId ?? null,
        name: input.name,
        description: input.description ?? null,
        isActive: input.isActive,
        type: input.type,
        value: input.value,
        startDate: calendarDate(input.startDate),
        endDate: calendarDate(input.endDate),
        daysOfWeek: input.daysOfWeek,
        startTime: input.startTime,
        endTime: input.endTime,
        priority: input.priority,
        updatedBy: ctx.employeeId,
        targets: { createMany: { data: targetCreateRows(input.targets) } },
      },
      include: PROMOTION_INCLUDE,
    });
    await recordAuditEntry(
      ctx,
      {
        entityType: "Promotion",
        entityId: id,
        action: "promotion.edited",
        previousValue: auditSnapshot(existing),
        newValue: auditSnapshot(result),
        locationId: input.locationId ?? undefined,
        category: "promotion",
      },
      tx
    );
    return result;
  });

  await invalidateMenuSnapshotCache(ctx.restaurantId);
  return updated;
}

async function setActive(ctx: AuthContext, id: string, isActive: boolean) {
  requirePermission(ctx, PROMOTIONS_MANAGE);
  const existing = await prisma.promotion.findFirst({ where: { id, ...scopeToRestaurant(ctx) } });
  if (!existing) throw new Error("Promocija nije pronađena");

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.promotion.update({ where: { id }, data: { isActive, updatedBy: ctx.employeeId } });
    await recordAuditEntry(
      ctx,
      {
        entityType: "Promotion",
        entityId: id,
        action: isActive ? "promotion.activated" : "promotion.deactivated",
        previousValue: { isActive: existing.isActive },
        newValue: { isActive },
        locationId: existing.locationId ?? undefined,
        category: "promotion",
      },
      tx
    );
    return result;
  });

  await invalidateMenuSnapshotCache(ctx.restaurantId);
  return updated;
}

export const activatePromotion = (ctx: AuthContext, id: string) => setActive(ctx, id, true);
export const deactivatePromotion = (ctx: AuthContext, id: string) => setActive(ctx, id, false);

/**
 * Raw, unevaluated promotion rules for the waiter Menu Snapshot (spec
 * section 9/10 — instant client-side promo price preview). Deliberately
 * NOT cached alongside the categories/items snapshot (which has its own
 * Redis version-counter consistency dance) — Promotion rows are few per
 * restaurant, so one small indexed query per snapshot fetch (itself only
 * once per shift login, see menu-service.ts) is negligible, and it sidesteps
 * a second cache-versioning dimension entirely. The CLIENT evaluates
 * activeness/precedence locally via the exact same pickWinningPromotion/
 * isScheduleActiveAt used here — see packages/shared/promotion-schedule.ts.
 */
export async function listActivePromotionRulesForSnapshot(restaurantId: string, locationId: string) {
  const [rows, restaurant] = await Promise.all([
    prisma.promotion.findMany({
      where: { restaurantId, isActive: true, archivedAt: null, OR: [{ locationId: null }, { locationId }] },
      include: { targets: { select: { targetType: true, menuItemId: true, categoryId: true } } },
    }),
    prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { timezone: true } }),
  ]);
  return {
    timezone: restaurant.timezone,
    rules: rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      value: row.value.toString(),
      priority: row.priority,
      createdAt: row.createdAt.toISOString(),
      schedule: toScheduleRule(row),
      targets: row.targets.map((t) => ({ targetType: t.targetType, menuItemId: t.menuItemId, categoryId: t.categoryId })),
    })),
  };
}

export interface EffectivePriceResult {
  regularPrice: Prisma.Decimal;
  effectivePrice: Prisma.Decimal;
  promotion: null | { id: string; name: string; type: "PERCENTAGE_DISCOUNT" | "FIXED_PRICE"; value: Prisma.Decimal };
}

interface PricingLine {
  menuItemId: string;
  categoryId: string | null;
  /** MenuItem.price — WITHOUT modifiers. */
  basePrice: Prisma.Decimal | number | string;
  /** Sum of selected modifier priceDelta — always added on top, never discounted (spec section 3/6 leaves this an open question; V1 picks "promotions discount the base item, not add-ons," documented here). */
  modifierDelta: Prisma.Decimal | number | string;
}

type PromotionRowWithTargets = PromotionRow & { targets: Array<{ targetType: "MENU_ITEM" | "MENU_CATEGORY"; menuItemId: string | null; categoryId: string | null }> };

/**
 * Shared per-line evaluation, given an ALREADY-LOADED set of candidate
 * Promotion rows (loaded once by either resolveEffectivePrice or the
 * batched resolveEffectivePrices below) and the restaurant's timezone.
 * Safety net: a "promotion" is never applied if doing so would RAISE the
 * price above the plain regular price (e.g. a misconfigured FIXED_PRICE
 * promo higher than a cheap item's own regular price) — a promotions engine
 * must never accidentally overcharge.
 */
function evaluateLine(rows: PromotionRowWithTargets[], line: PricingLine, at: Date, timezone: string): EffectivePriceResult {
  const basePrice = new Prisma.Decimal(line.basePrice);
  const modifierDelta = new Prisma.Decimal(line.modifierDelta);
  const regularPrice = basePrice.add(modifierDelta).toDecimalPlaces(2);

  const candidates: PromotionCandidate[] = [];
  for (const row of rows) {
    // A single Promotion row can list BOTH item- and category-targets
    // together (e.g. "Happy Hour" targeting the whole "Pivo" category AND
    // one specific item elsewhere) — evaluate once per matching target
    // type present on THIS row, never assume exactly one.
    const matchesItem = row.targets.some((t) => t.targetType === "MENU_ITEM" && t.menuItemId === line.menuItemId);
    const matchesCategory = Boolean(line.categoryId) && row.targets.some((t) => t.targetType === "MENU_CATEGORY" && t.categoryId === line.categoryId);
    const schedule = toScheduleRule(row);
    if (matchesItem) {
      candidates.push({ id: row.id, name: row.name, type: row.type, value: row.value.toString(), priority: row.priority, createdAt: row.createdAt, targetType: "MENU_ITEM", schedule });
    }
    if (matchesCategory) {
      candidates.push({ id: row.id, name: row.name, type: row.type, value: row.value.toString(), priority: row.priority, createdAt: row.createdAt, targetType: "MENU_CATEGORY", schedule });
    }
  }

  const winner = pickWinningPromotion(candidates, at, timezone);
  if (!winner) return { regularPrice, effectivePrice: regularPrice, promotion: null };

  const promoValue = new Prisma.Decimal(winner.value);
  const discountedBase =
    winner.type === "PERCENTAGE_DISCOUNT" ? basePrice.mul(new Prisma.Decimal(1).sub(promoValue.div(100))) : promoValue;
  const effectivePrice = discountedBase.add(modifierDelta).toDecimalPlaces(2);

  if (effectivePrice.greaterThan(regularPrice)) {
    // A "promotion" must never raise the price — treat as not applicable.
    return { regularPrice, effectivePrice: regularPrice, promotion: null };
  }

  return { regularPrice, effectivePrice, promotion: { id: winner.id, name: winner.name, type: winner.type, value: promoValue } };
}

function candidatePromotionWhere(menuItemIds: string[], categoryIds: string[]) {
  return {
    OR: [
      { targetType: "MENU_ITEM" as const, menuItemId: { in: menuItemIds } },
      ...(categoryIds.length > 0 ? [{ targetType: "MENU_CATEGORY" as const, categoryId: { in: categoryIds } }] : []),
    ],
  };
}

/**
 * THE authoritative pricing resolver (single line) — see module doc
 * comment. Called from order-service.ts's addItem for the instant draft
 * preview. submitOrder uses the batched resolveEffectivePrices below
 * instead, to stay within its existing "one query for every item, never
 * per-item" discipline (spec section 26 performance requirement).
 *
 * PERFORMANCE (P0 Instant Waiter Engine): the overwhelming majority of
 * addItem calls are for items with NO promotion targeting them at all — the
 * promotion-candidates query below is a small, indexed lookup that returns
 * an EMPTY array for those, and Restaurant.timezone (a second, otherwise-
 * unnecessary query) is only ever fetched when at least one candidate
 * actually exists, never unconditionally on every add.
 */
export async function resolveEffectivePrice(params: PricingLine & { restaurantId: string; locationId: string; at: Date }): Promise<EffectivePriceResult> {
  const rows = await prisma.promotion.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      archivedAt: null,
      OR: [{ locationId: null }, { locationId: params.locationId }],
      targets: { some: candidatePromotionWhere([params.menuItemId], params.categoryId ? [params.categoryId] : []) },
    },
    include: { targets: true },
  });
  if (rows.length === 0) {
    const basePrice = new Prisma.Decimal(params.basePrice);
    const regularPrice = basePrice.add(new Prisma.Decimal(params.modifierDelta)).toDecimalPlaces(2);
    return { regularPrice, effectivePrice: regularPrice, promotion: null };
  }

  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: params.restaurantId }, select: { timezone: true } });
  return evaluateLine(rows, params, params.at, restaurant.timezone);
}

/**
 * Batched variant of resolveEffectivePrice — ONE promotion query covering
 * every distinct menuItemId/categoryId across all `lines`, used by
 * order-service.ts's submitOrder re-snapshot so pricing N order lines never
 * costs N queries inside the critical submit transaction.
 */
export async function resolveEffectivePrices(params: {
  restaurantId: string;
  locationId: string;
  lines: Array<PricingLine & { key: string }>;
  at: Date;
}): Promise<Map<string, EffectivePriceResult>> {
  const result = new Map<string, EffectivePriceResult>();
  if (params.lines.length === 0) return result;

  const menuItemIds = [...new Set(params.lines.map((l) => l.menuItemId))];
  const categoryIds = [...new Set(params.lines.map((l) => l.categoryId).filter((id): id is string => id !== null))];

  const rows = await prisma.promotion.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      archivedAt: null,
      OR: [{ locationId: null }, { locationId: params.locationId }],
      targets: { some: candidatePromotionWhere(menuItemIds, categoryIds) },
    },
    include: { targets: true },
  });

  if (rows.length === 0) {
    for (const line of params.lines) {
      const basePrice = new Prisma.Decimal(line.basePrice);
      const regularPrice = basePrice.add(new Prisma.Decimal(line.modifierDelta)).toDecimalPlaces(2);
      result.set(line.key, { regularPrice, effectivePrice: regularPrice, promotion: null });
    }
    return result;
  }

  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: params.restaurantId }, select: { timezone: true } });
  for (const line of params.lines) {
    result.set(line.key, evaluateLine(rows, line, params.at, restaurant.timezone));
  }
  return result;
}
