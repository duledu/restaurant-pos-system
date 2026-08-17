import { NextResponse } from "next/server";
import { reporting } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId") ?? "ALL";
  const status = await reporting.getCurrentStatus(ctx, { locationId });
  return NextResponse.json(status);
});
