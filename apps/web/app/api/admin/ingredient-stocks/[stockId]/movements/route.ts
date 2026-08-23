import { NextResponse } from "next/server";
import { ingredients } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const GET = withApiAuth<{ stockId: string }>(async (ctx, _request, { stockId }) => {
  const movements = await ingredients.getMovements(ctx, stockId);
  return NextResponse.json({ movements });
});
