import { NextResponse } from "next/server";
import { inventory } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId") ?? "ALL";
  const summary = await inventory.getStockAttention(ctx, locationId);
  return NextResponse.json(summary);
});
