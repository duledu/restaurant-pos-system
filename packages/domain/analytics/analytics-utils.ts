import { Prisma } from "@rcs/db";

/**
 * FAZA 7 — deljeni matematički helperi za analitiku. Namerno odvojeno od
 * reporting-service.ts (koji ostaje jedini izvor FINANSIJSKIH formula) —
 * ovo su čisto prezentacione/statističke pomoćne funkcije (procentualna
 * promena, bezbedno deljenje), ne novi izvor istine za novac.
 */

/**
 * Procentualna promena current-a u odnosu na previous. `null` kad previous
 * nema smisla za poređenje (0 ili nedostupan) — zahtev specifikacije #1/#16:
 * "Do not show fake percentage changes... Never show Infinity/NaN."
 */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  const change = ((current - previous) / previous) * 100;
  return Number.isFinite(change) ? Math.round(change * 10) / 10 : null;
}

export function decimalToNumber(value: Prisma.Decimal | string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

/** Bezbedno deljenje — `null` (ne NaN/Infinity) kad je imenilac 0. */
export function safeDiv(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
