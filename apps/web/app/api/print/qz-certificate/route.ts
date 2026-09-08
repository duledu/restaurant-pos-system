import { NextResponse } from "next/server";
import { withApiAuth } from "../../../../lib/api-helpers";

/**
 * P0.16 — QZ Tray sertifikat (qz.security.setCertificatePromise). Vraća
 * JAVNI sertifikat iz env promenljive — nikad privatni ključ, nikad
 * hardkodovan/izmišljen ovde. Ako QZ_CERTIFICATE nije podešen, vraća prazan
 * string — QZ Tray tad prikazuje SOPSTVENI "nepouzdano, dozvoli jednom?"
 * prompt umesto tihe štampe (bezbedan, dokumentovan fallback, ne greška).
 * Iza withApiAuth samo iz opreza (dosledno ostatku API-ja) — sam sertifikat
 * nije osetljiv (to je upravo ono što se pokazuje QZ Tray-u).
 */
export const GET = withApiAuth(async () => {
  return NextResponse.json({ certificate: process.env.QZ_CERTIFICATE ?? "" });
});
