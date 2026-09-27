import { NextResponse } from "next/server";
import { reservations } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  const query = url.searchParams.get("q") ?? "";
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  const items = await reservations.searchReservations(ctx, locationId, query);
  return NextResponse.json({ reservations: items });
});
