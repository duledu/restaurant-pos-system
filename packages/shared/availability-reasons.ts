/**
 * Deljeno između servera (validacija) i klijenta (padajuća lista na Kuhinja/
 * Šank ekranu dostupnosti) — isti obrazac kao void-reasons.ts.
 */

export const AVAILABILITY_REASON_CODES = [
  "NEMA_PROIZVODA",
  "NEMA_SIROVINE_FIZICKI",
  "OPREMA_KVAR",
  "NEMA_STRUJE_GASA",
  "STANICA_NE_RADI",
  "NIJE_MOGUCE_PRIPREMITI",
  "DRUGO",
] as const;

export type AvailabilityReasonCode = (typeof AVAILABILITY_REASON_CODES)[number];

export const AVAILABILITY_REASON_LABELS: Record<AvailabilityReasonCode, string> = {
  NEMA_PROIZVODA: "Nema proizvoda",
  NEMA_SIROVINE_FIZICKI: "Nema sirovine fizički",
  OPREMA_KVAR: "Oprema / kvar",
  NEMA_STRUJE_GASA: "Nema struje / gasa",
  STANICA_NE_RADI: "Stanica privremeno ne radi",
  NIJE_MOGUCE_PRIPREMITI: "Nije moguće pripremiti",
  DRUGO: "Drugo",
};
