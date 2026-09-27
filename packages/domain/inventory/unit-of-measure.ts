/**
 * P1: Normativi/sirovine — jedinice mere. Čista, DOM-free logika (testabilna
 * bez baze) — vidi tests/unit/unit-of-measure.test.ts.
 *
 * Ingredient ima jednu kanoničku jedinicu (unit) za stanje, kretanja i
 * sačuvane normative. Unos normativa može koristiti kompatibilnu jedinicu;
 * server je konvertuje Decimal aritmetikom PRE upisa. kg/g i l/ml imaju
 * faktor 1000. PIECE se ne konvertuje u masu ili zapreminu.
 */

import { Prisma } from "@prisma/client";

export type UnitOfMeasure = "KILOGRAM" | "GRAM" | "LITER" | "MILLILITER" | "PIECE";

export const UNIT_LABELS_SR: Record<UnitOfMeasure, string> = {
  KILOGRAM: "kg",
  GRAM: "g",
  LITER: "l",
  MILLILITER: "ml",
  PIECE: "kom",
};

export const ALL_UNITS: UnitOfMeasure[] = ["KILOGRAM", "GRAM", "LITER", "MILLILITER", "PIECE"];

type UnitDimension = "MASS" | "VOLUME" | "COUNT";

const UNIT_DIMENSION: Record<UnitOfMeasure, UnitDimension> = {
  KILOGRAM: "MASS",
  GRAM: "MASS",
  LITER: "VOLUME",
  MILLILITER: "VOLUME",
  PIECE: "COUNT",
};

// Faktor za konverziju U odgovarajuću BAZNU jedinicu dimenzije (gram za
// masu, mililitar za zapreminu) — 1 za baznu jedinicu samu.
const TO_BASE_FACTOR: Record<UnitOfMeasure, number> = {
  KILOGRAM: 1000, // -> grams
  GRAM: 1,
  LITER: 1000, // -> milliliters
  MILLILITER: 1,
  PIECE: 1,
};

export function unitDimension(unit: UnitOfMeasure): UnitDimension {
  return UNIT_DIMENSION[unit];
}

export function unitLabelSr(unit: UnitOfMeasure): string {
  return UNIT_LABELS_SR[unit];
}

/**
 * Konvertuje količinu iz jedne jedinice u drugu — baca grešku ako jedinice
 * nisu iste dimenzije (npr. GRAM -> LITER) ili ako je bilo koja strana
 * PIECE dok druga nije (komad se ne konvertuje ni u šta).
 */
export function convertUnit(quantity: number, from: UnitOfMeasure, to: UnitOfMeasure): number {
  return convertUnitDecimal(quantity, from, to).toNumber();
}

/** Authoritative conversion retains Decimal through persistence. */
export function convertUnitDecimal(quantity: Prisma.Decimal.Value, from: UnitOfMeasure, to: UnitOfMeasure): Prisma.Decimal {
  const amount = new Prisma.Decimal(quantity);
  if (!amount.isFinite()) throw new Error("Količina mora biti konačan broj");
  if (!ALL_UNITS.includes(from) || !ALL_UNITS.includes(to)) throw new Error("Nepoznata jedinica mere");
  if (from === to) return amount;
  const fromDim = unitDimension(from);
  const toDim = unitDimension(to);
  if (fromDim !== toDim) {
    throw new Error(`Nekompatibilne jedinice: ${from} (${fromDim}) -> ${to} (${toDim})`);
  }
  if (fromDim === "COUNT") {
    // Nedostižno u praksi (from!==to i obe COUNT znači obe PIECE, from===to
    // bi već vratio ranije) — čuvano eksplicitno radi jasne greške ako se
    // ikad doda druga COUNT jedinica.
    throw new Error("Diskretne (PIECE) jedinice se ne konvertuju");
  }
  return amount.mul(TO_BASE_FACTOR[from]).div(TO_BASE_FACTOR[to]);
}
