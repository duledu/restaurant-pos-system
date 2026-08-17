import { NextResponse } from "next/server";
import { audit } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId") ?? "ALL";
  const signals = await audit.getSuspiciousActivity(ctx, { locationId });
  return NextResponse.json({ signals });
});
