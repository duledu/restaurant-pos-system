import { NextResponse } from "next/server";
import { audit } from "@rcs/domain";
import { requirePermission } from "@rcs/auth";
import { reportPrintAuditSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

// Isti skup podržanih izveštaja kao u export/route.ts (namerno ne uvozimo
// odatle — ta lista nije eksportovana, i ovo je jedini drugi poziv koji je
// koristi, pa lokalna kopija ostaje jednostavnija od dodatnog deljenog
// modula za dva mesta).
const REPORT_TYPES = [
  "sales",
  "items",
  "employees",
  "shifts",
  "voids",
  "daily-summary",
  // ── Faza 7 (BI dashboard) ──
  "dashboard",
  "categories",
  "discounts-by-employee",
  "payments",
  "employees-normalized",
] as const;

/**
 * Klijent poziva OVO neposredno pre window.print() na bilo kom izveštaju —
 * audituje se PRINT radnja nad (potencijalno finansijskim) istorijskim
 * podacima (zahtev #26). Ne dira nijedan poslovni podatak.
 *
 * Ista permisija kao pristup samim finansijskim izveštajima ("audit.view",
 * vidi reporting-service.ts) — ko ne sme da VIDI izveštaj, ne sme ni da
 * upiše da ga je štampao.
 */
export const POST = withApiAuth(async (ctx, request) => {
  requirePermission(ctx, "audit.view");
  const body = await request.json();
  const input = reportPrintAuditSchema.parse(body);
  if (!REPORT_TYPES.includes(input.reportType as (typeof REPORT_TYPES)[number])) {
    return NextResponse.json({ error: "Nepoznat tip izveštaja" }, { status: 400 });
  }
  await audit.recordAuditEntry(ctx, {
    entityType: "Report",
    entityId: input.reportType,
    action: "report.printed",
    newValue: input,
  });
  return NextResponse.json({ ok: true });
});
