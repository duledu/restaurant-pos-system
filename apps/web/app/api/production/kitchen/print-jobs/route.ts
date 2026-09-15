import { NextResponse } from "next/server";
import { printing, agentPrinting } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  // printerStatus je JEDINI server-autoritativan izvor za KDS prikaz
  // spremnosti štampača (nikad QZ/browser localStorage) — agentActiveForStation
  // se izvodi iz istog rezultata (isOnline), ne posebnim upitom.
  const [result, printerStatus] = await Promise.all([
    printing.listPendingStationPrintJobs(ctx, locationId, "KITCHEN"),
    agentPrinting.stationPrinterStatus(ctx.restaurantId, locationId, "KITCHEN"),
  ]);
  // Part 13 hardening — "poslednja štampa nije uspela" je po-poslu signal
  // (već dobijen u result.jobs), sklopljen ovde bez dodatnog upita, nikad
  // duplirajući stationPrinterStatus-ovu sopstvenu, stanicu-nivoa definiciju.
  const hasRecentFailure = result.jobs.some((j) => j.status === "FAILED" || j.status === "SUBMISSION_UNKNOWN");
  return NextResponse.json({ ...result, agentActiveForStation: printerStatus.isOnline, printerStatus, hasRecentFailure });
});
