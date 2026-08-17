/**
 * Deljeno između servera (validacija) i klijenta (padajuća lista u modalu
 * za poništavanje) — jedan izvor istine za dozvoljene razloge, vidi Fazu 4.
 */

export const VOID_REASON_CODES = [
  "ORDERED_BY_MISTAKE",
  "WRONG_QUANTITY",
  "CUSTOMER_CHANGED_MIND",
  "WRONG_ITEM",
  "KITCHEN_UNAVAILABLE",
  "KITCHEN_ISSUE",
  "QUALITY_ISSUE",
  "MANAGER_DECISION",
  "OTHER",
] as const;

export type VoidReasonCode = (typeof VOID_REASON_CODES)[number];

export const VOID_REASON_LABELS: Record<VoidReasonCode, string> = {
  ORDERED_BY_MISTAKE: "Poručeno greškom",
  WRONG_QUANTITY: "Pogrešno uneta količina",
  CUSTOMER_CHANGED_MIND: "Gost je promenio mišljenje",
  WRONG_ITEM: "Pogrešan artikal",
  KITCHEN_UNAVAILABLE: "Kuhinja nema sastojak",
  KITCHEN_ISSUE: "Problem u kuhinji",
  QUALITY_ISSUE: "Problem sa kvalitetom",
  MANAGER_DECISION: "Odluka menadžera",
  OTHER: "Drugo",
};

const JUNK_EXPLANATIONS = new Set([".", "-", "x", "test", "n/a", "na", "asdf", "...", "ok", "/"]);

/**
 * Namerno JEDNOSTAVNA validacija (zahtev specifikacije #6 — bez AI/ML):
 * minimalna smislena dužina + odbacivanje očiglednih besmislica ("test",
 * "-", ponovljen jedan karakter). Ne pokušava da otkrije SVAKU besmislicu —
 * to nije cilj.
 */
export function isMeaningfulVoidExplanation(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 10) return false;
  const normalized = trimmed.toLowerCase();
  if (JUNK_EXPLANATIONS.has(normalized)) return false;
  if (/^(.)\1*$/.test(trimmed)) return false; // ponovljen jedan karakter, npr. "xxxxxxxxxx"
  return true;
}
