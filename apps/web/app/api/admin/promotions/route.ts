import { NextResponse } from "next/server";
import { promotions } from "@rcs/domain";
import { createPromotionSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const includeArchived = url.searchParams.get("includeArchived") === "1";
  const items = await promotions.listPromotions(ctx, { includeArchived });
  return NextResponse.json({ promotions: items });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createPromotionSchema.parse(body);
  const promotion = await promotions.createPromotion(ctx, input);
  return NextResponse.json({ promotion }, { status: 201 });
});
