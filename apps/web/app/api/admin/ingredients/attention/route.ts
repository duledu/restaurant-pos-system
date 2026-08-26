import { NextResponse } from "next/server";
import { ingredients } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

/** P1.7 audit §8: Owner Control Center negative-ingredient-stock alert. */
export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId") ?? "ALL";
  const summary = await ingredients.getIngredientStockAttention(ctx, locationId);
  return NextResponse.json(summary);
});
