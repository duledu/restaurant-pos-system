import { NextResponse } from "next/server";
import { availability } from "@rcs/domain";
import { setMenuItemAvailabilitySchema } from "@rcs/shared";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  const station = url.searchParams.get("station");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  if (station !== "KITCHEN" && station !== "BAR") {
    return NextResponse.json({ error: "station mora biti KITCHEN ili BAR" }, { status: 400 });
  }
  const items = await availability.listAvailabilityForStation(ctx, locationId, station);
  return NextResponse.json({ items });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = setMenuItemAvailabilitySchema.parse(body);
  const result = await availability.setAvailability(ctx, input);
  return NextResponse.json(result);
});
