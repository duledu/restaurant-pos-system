import { NextResponse } from "next/server";
import { inventoryCategories } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const category = await inventoryCategories.deactivateInventoryCategory(ctx, id);
  return NextResponse.json({ category });
});
