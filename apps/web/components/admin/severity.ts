export type Severity = "INFO" | "WARNING" | "HIGH";

export const SEVERITY_BADGE_TONE: Record<Severity, "info" | "warn" | "danger"> = {
  INFO: "info",
  WARNING: "warn",
  HIGH: "danger",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  INFO: "Informativno",
  WARNING: "Pažnja",
  HIGH: "Visok prioritet",
};

const SIGNAL_CATEGORY_LABEL: Record<string, string> = {
  FREQUENT_VOIDS: "Učestala poništavanja",
  HIGH_VALUE_VOID: "Poništavanje visoke vrednosti",
  REPEATED_VOID_REASON: "Ponovljen razlog poništavanja",
  VOID_AFTER_PRODUCTION: "Storno nakon slanja u proizvodnju",
  CASH_DISCREPANCY: "Razlika u gotovini",
  UNAUTHORIZED_ATTEMPTS: "Odbijeni pokušaji bez ovlašćenja",
  LARGE_INVENTORY_WRITE_OFF: "Veliki otpis zaliha",
  FREQUENT_INVENTORY_ADJUSTMENTS: "Česte korekcije zaliha",
  REPEATED_ITEM_WRITE_OFF: "Ponovljen otpis artikla",
};

export function signalCategoryLabel(category: string): string {
  return SIGNAL_CATEGORY_LABEL[category] ?? category;
}
