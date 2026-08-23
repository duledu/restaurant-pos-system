/**
 * P1: Normativi/sirovine — jedinice mere. Čista, DOM-free logika (testabilna
 * bez baze) — vidi tests/unit/unit-of-measure.test.ts.
 *
 * Namerna odluka za ovu fazu: Ingredient ima TAČNO JEDNU jedinicu (unit)
 * kojom se izražava i njeno stanje zaliha I svaka receptura koja je koristi
 * — nema po-recepturi override jedinice, pa nema potrebe za konverzijom
 * PRI UPISU (npr. "Mleveno meso" je uvek u kg, nikad mešano g/kg za istu
 * sirovinu). Ova tabela ipak postoji i pokriva pun KILOGRAM<->GRAM i
 * LITER<->MILLILITER konverzioni par — pripremljena za UI prikaz (npr.
 * prikaz sitnih količina u gramima umesto 0.003 kg) i za kasniju fazu ako
 * se pokaže potreba za konverzijom. PIECE se NAMERNO nikad ne konvertuje —
 * komad je diskretna jedinica bez mase/zapremine.
 */

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
  if (from === to) return quantity;
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
  const inBase = quantity * TO_BASE_FACTOR[from];
  return inBase / TO_BASE_FACTOR[to];
}
