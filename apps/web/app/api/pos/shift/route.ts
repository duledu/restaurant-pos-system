import { NextResponse } from "next/server";
import { shifts } from "@rcs/domain";
import { openShiftSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../lib/api-helpers";

// GET ?locationId=... -> aktivna smena (ili null)
export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  const shift = await shifts.getActiveShift(ctx, locationId);
  return NextResponse.json({ shift });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = openShiftSchema.parse(body);
  const shift = await shifts.openShift(ctx, input);
  return NextResponse.json({ shift }, { status: 201 });
});
