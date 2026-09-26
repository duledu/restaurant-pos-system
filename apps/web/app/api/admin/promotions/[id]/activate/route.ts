import { NextResponse } from "next/server";
import { promotions } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const promotion = await promotions.activatePromotion(ctx, id);
  return NextResponse.json({ promotion });
});
