/**
 * P3.3 — čisto formatiranje prikaza količine zalihe. Inventory koristi
 * Decimal(12,3) (specifikacija #37) — "2.500"/"0.750" su legitimne
 * vrednosti, ne greška. Ne zaokružuje na celobrojno; prikazuje najviše 3
 * decimale i uklanja suvišne nule (2.500 -> "2.5", 3.000 -> "3").
 */
export function formatStockQty(raw: string | number): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "0";
  const trimmed = n.toFixed(3).replace(/\.?0+$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}
