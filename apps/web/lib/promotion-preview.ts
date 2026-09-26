/**
 * PROMOTIONS & PRICING ENGINE V1 — client-side price PREVIEW only.
 *
 * Mirrors packages/domain/promotions/promotion-service.ts's resolveEffectivePrice
 * using the exact same shared, pure evaluator (packages/shared/promotion-schedule.ts)
 * so the waiter's instant preview can never disagree with server authority about
 * WHICH promotion wins — only the server's Decimal-based computation is ever
 * trusted for money actually charged (see order-service.ts addItem/submitOrder).
 *
 * Plain JS number arithmetic here (not Decimal) is a DELIBERATE, pre-existing
 * pattern match — waiter-local-draft.ts's add() already computes the base+
 * modifier preview price the same way, for the same reason (optimistic local
 * rendering only, never the source of a real charge).
 */
import { useEffect, useState } from "react";
import { isScheduleActiveAt, pickWinningPromotion, nextScheduleBoundary, type PromotionCandidate, type PromotionScheduleRule } from "@rcs/shared";

export interface PromotionRule {
  id: string;
  name: string;
  type: "PERCENTAGE_DISCOUNT" | "FIXED_PRICE";
  value: string;
  priority: number;
  createdAt: string;
  schedule: PromotionScheduleRule;
  targets: Array<{ targetType: "MENU_ITEM" | "MENU_CATEGORY"; menuItemId: string | null; categoryId: string | null }>;
}

export interface PricePreview {
  regularPrice: number;
  effectivePrice: number;
  promotion: null | { id: string; name: string; type: "PERCENTAGE_DISCOUNT" | "FIXED_PRICE"; value: string };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function previewEffectivePrice(
  basePrice: number,
  modifierDelta: number,
  menuItemId: string,
  categoryId: string | null,
  rules: readonly PromotionRule[],
  at: Date,
  timezone: string
): PricePreview {
  const regularPrice = round2(basePrice + modifierDelta);
  if (rules.length === 0) return { regularPrice, effectivePrice: regularPrice, promotion: null };

  const candidates: PromotionCandidate[] = [];
  for (const rule of rules) {
    const matchesItem = rule.targets.some((t) => t.targetType === "MENU_ITEM" && t.menuItemId === menuItemId);
    const matchesCategory = categoryId !== null && rule.targets.some((t) => t.targetType === "MENU_CATEGORY" && t.categoryId === categoryId);
    if (matchesItem) candidates.push({ id: rule.id, name: rule.name, type: rule.type, value: rule.value, priority: rule.priority, createdAt: rule.createdAt, targetType: "MENU_ITEM", schedule: rule.schedule });
    if (matchesCategory) candidates.push({ id: rule.id, name: rule.name, type: rule.type, value: rule.value, priority: rule.priority, createdAt: rule.createdAt, targetType: "MENU_CATEGORY", schedule: rule.schedule });
  }

  const winner = pickWinningPromotion(candidates, at, timezone);
  if (!winner) return { regularPrice, effectivePrice: regularPrice, promotion: null };

  const value = Number(winner.value);
  const discountedBase = winner.type === "PERCENTAGE_DISCOUNT" ? basePrice * (1 - value / 100) : value;
  const effectivePrice = round2(discountedBase + modifierDelta);
  if (effectivePrice > regularPrice) return { regularPrice, effectivePrice: regularPrice, promotion: null };

  return { regularPrice, effectivePrice, promotion: { id: winner.id, name: winner.name, type: winner.type, value: String(winner.value) } };
}

/** Is ANY rule targeting this item/category active right now? Cheap existence check for badge rendering without computing a full preview. */
export function hasActivePromotion(menuItemId: string, categoryId: string | null, rules: readonly PromotionRule[], at: Date, timezone: string): boolean {
  return rules.some((rule) => {
    const matches = rule.targets.some(
      (t) => (t.targetType === "MENU_ITEM" && t.menuItemId === menuItemId) || (t.targetType === "MENU_CATEGORY" && t.categoryId === categoryId)
    );
    return matches && isScheduleActiveAt(rule.schedule, at, timezone);
  });
}

/**
 * Spec section 10 — "no aggressive polling, schedule expiry is
 * deterministic." Returns ms until the NEXT moment any rule's activeness
 * could change, for scheduling exactly one setTimeout (see usePromotionTick
 * in waiter-shell.tsx) instead of polling.
 */
export function msUntilNextPromoBoundary(rules: readonly PromotionRule[], at: Date, timezone: string): number | null {
  let min: number | null = null;
  for (const rule of rules) {
    const next = nextScheduleBoundary(rule.schedule, at, timezone);
    if (!next) continue;
    const ms = next.getTime() - at.getTime();
    if (min === null || ms < min) min = ms;
  }
  return min;
}

/**
 * A clock that only "ticks" (re-renders) exactly when a promotion's
 * activeness could actually change — never a fixed interval. Schedules
 * exactly ONE setTimeout via msUntilNextPromoBoundary, re-scheduling after
 * each fire; when there is nothing to watch (no rules, or every rule's
 * schedule is permanently settled), it sets no timer at all.
 */
export function usePromotionClock(rules: readonly PromotionRule[], timezone: string): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (rules.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      const current = new Date();
      setNow(current);
      const ms = msUntilNextPromoBoundary(rules, current, timezone);
      if (ms !== null) timer = setTimeout(refresh, Math.max(1, Math.min(ms, 24 * 60 * 60 * 1000)));
    };
    const resume = () => { if (document.visibilityState !== "hidden") refresh(); };
    refresh();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [rules, timezone]);
  return now;
}
