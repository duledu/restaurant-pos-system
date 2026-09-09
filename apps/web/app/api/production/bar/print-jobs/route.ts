import { NextResponse } from "next/server";
import { printing, agentPrinting } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  const [result, agentActiveForStation] = await Promise.all([
    printing.listPendingStationPrintJobs(ctx, locationId, "BAR"),
    agentPrinting.isAgentActiveForStation(ctx.restaurantId, locationId, "BAR"),
  ]);
  return NextResponse.json({ ...result, agentActiveForStation });
});
