import { NextResponse } from "next/server";
import { inventura } from "@rcs/domain";
import { enterInventoryCountPhysicalQtySchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string; lineId: string }>(async (ctx, request, { id, lineId }) => {
  const body = await request.json();
  const input = enterInventoryCountPhysicalQtySchema.parse(body);
  const line = await inventura.enterPhysicalQuantity(ctx, id, lineId, input.physicalQty);
  return NextResponse.json({ line });
});
