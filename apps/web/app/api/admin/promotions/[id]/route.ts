import { NextResponse } from "next/server";
import { promotions } from "@rcs/domain";
import { updatePromotionSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const promotion = await promotions.getPromotion(ctx, id);
  return NextResponse.json({ promotion });
});

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updatePromotionSchema.parse(body);
  const promotion = await promotions.updatePromotion(ctx, id, input);
  return NextResponse.json({ promotion });
});
