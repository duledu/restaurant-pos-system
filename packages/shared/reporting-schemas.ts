import { z } from "zod";

export const REPORT_PRESETS = [
  "today",
  "yesterday",
  "thisWeek",
  "lastWeek",
  "thisMonth",
  "lastMonth",
  "thisYear",
  "lastYear",
  "last7days",
  "last30days",
  "custom",
] as const;

/**
 * Zajednički filter za sve Faza 5 izveštajne rute — GET query string, pa su
 * sva polja stringovi na ulazu (transform-uju se dole). locationId "ALL"
 * znači "sve lokacije NA KOJE zaposleni ima pristup" — server to primenjuje
 * u servisu (ctx.locationIds), nikad se ne veruje klijentu za stvarni
 * spisak lokacija.
 */
export const reportFiltersSchema = z
  .object({
    locationId: z.string().default("ALL"),
    preset: z.enum(REPORT_PRESETS).default("today"),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine((v) => v.preset !== "custom" || (v.from && v.to), {
    message: "Prilagođeni period zahteva 'from' i 'to' datume",
  });
export type ReportFiltersInput = z.infer<typeof reportFiltersSchema>;

// ── FAZA 6: audit log za PRINT/EXPORT osetljivih (finansijskih) izveštaja ──
export const reportPrintAuditSchema = z.object({
  reportType: z.string().trim().min(1).max(50),
  preset: z.string().trim().min(1).max(30),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type ReportPrintAuditInput = z.infer<typeof reportPrintAuditSchema>;
