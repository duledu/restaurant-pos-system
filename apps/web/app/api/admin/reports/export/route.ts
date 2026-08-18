import { NextResponse } from "next/server";
import { reporting, audit, analytics } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";
import { parseReportFilters } from "../../../../../lib/report-filters";

/**
 * CSV export (bez novih zavisnosti — ručni serializer ispod). "Export PDF"
 * u UI-ju NAMERNO ne prolazi kroz ovu rutu — koristi browser Print dijalog
 * (Sačuvaj kao PDF) nad istim print-report.css slojem koji se koristi za
 * fizičku štampu izveštaja (zahtev #24: "izveštaji optimizovani za A4").
 * Ovo izbegava novu server-side PDF zavisnost (npr. puppeteer) za MVP dok
 * se ne pokaže stvarna potreba za serverski generisanim PDF-om.
 */
const REPORT_TYPES = [
  "sales",
  "items",
  "employees",
  "shifts",
  "voids",
  "daily-summary",
  // ── Faza 7 (BI dashboard) — nove, ranije nepostojeće CSV tabele ──
  "categories",
  "discounts-by-employee",
  "payments",
  "employees-normalized",
] as const;
type ReportType = (typeof REPORT_TYPES)[number];

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))];
  return lines.join("\n");
}

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const reportType = url.searchParams.get("reportType");
  if (!reportType || !REPORT_TYPES.includes(reportType as ReportType)) {
    return NextResponse.json({ error: "Nepoznat tip izveštaja za export" }, { status: 400 });
  }
  const filters = parseReportFilters(url);

  let rows: Record<string, unknown>[];
  switch (reportType as ReportType) {
    case "sales": {
      const summary = await reporting.getSalesSummary(ctx, filters);
      rows = [summary as unknown as Record<string, unknown>];
      break;
    }
    case "items": {
      const report = await reporting.getSoldItems(ctx, filters);
      rows = report.rows as unknown as Record<string, unknown>[];
      break;
    }
    case "employees":
      rows = (await reporting.getEmployeeActivity(ctx, filters)) as unknown as Record<string, unknown>[];
      break;
    case "shifts":
      rows = (await reporting.getShiftReport(ctx, filters)) as unknown as Record<string, unknown>[];
      break;
    case "voids":
      rows = (await reporting.getVoidReport(ctx, filters)) as unknown as Record<string, unknown>[];
      break;
    case "daily-summary": {
      const summary = await reporting.getDailySummary(ctx, filters);
      rows = [{ label: summary.label, generatedAt: summary.generatedAt, ...summary.sales } as unknown as Record<string, unknown>];
      break;
    }
    case "categories":
      rows = (await analytics.getCategoryPerformance(ctx, filters)).categories as unknown as Record<string, unknown>[];
      break;
    case "discounts-by-employee":
      rows = (await analytics.getDiscountIntelligence(ctx, filters)).byEmployee as unknown as Record<string, unknown>[];
      break;
    case "payments":
      rows = (await analytics.getPaymentBreakdown(ctx, filters)).methods as unknown as Record<string, unknown>[];
      break;
    case "employees-normalized":
      rows = (await analytics.getEmployeeNormalizedMetrics(ctx, filters)).rows as unknown as Record<string, unknown>[];
      break;
  }

  // Audit PRE odgovora — export od finansijske/istorijske vrednosti se
  // uvek beleži, bez izuzetka (zahtev #26).
  await audit.recordAuditEntry(ctx, {
    entityType: "Report",
    entityId: reportType,
    action: "report.exported",
    newValue: { reportType, format: "csv", preset: filters.preset, from: filters.from, to: filters.to },
  });

  const csv = toCsv(rows);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${reportType}-izvestaj.csv"`,
    },
  });
});
