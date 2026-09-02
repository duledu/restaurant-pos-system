import { NextResponse } from "next/server";
import { transfers } from "@rcs/domain";
import { transferOrderItemsSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = transferOrderItemsSchema.parse(body);
  const result = await transfers.transferOrderItems(ctx, id, input);
  return NextResponse.json(result);
});
