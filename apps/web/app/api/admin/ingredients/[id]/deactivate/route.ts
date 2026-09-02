import { NextResponse } from "next/server";
import { ingredients } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const ingredient = await ingredients.deactivateIngredient(ctx, id);
  return NextResponse.json({ ingredient });
});
