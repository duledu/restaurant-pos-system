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
  //
  // PREPROD physical QA follow-up — hasRecentFailure VIŠE NIJE izveden iz
  // result.jobs (ta lista nema starosnu/smensku granicu — vidi
  // hasRecentPrintFailure u print-service.ts za pun razlog i staro
  // ponašanje). Poseban, ciljan upit umesto "besplatnog" izvođenja iz već
  // dobijenih podataka je NAMERNA cena — stara jeftina putanja je bila
  // upravo pogrešna semantika koju ovo ispravlja.
  const [result, printerStatus, hasRecentFailure] = await Promise.all([
    printing.listPendingStationPrintJobs(ctx, locationId, "BAR"),
    agentPrinting.stationPrinterStatus(ctx.restaurantId, locationId, "BAR"),
    printing.hasRecentPrintFailure(ctx, locationId, "BAR"),
  ]);
  return NextResponse.json({ ...result, agentActiveForStation: printerStatus.isOnline, printerStatus, hasRecentFailure });
});
