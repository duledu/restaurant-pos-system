import { NextResponse } from "next/server";
import { orders } from "@rcs/domain";
import { updateOrderItemModifiersSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

export const PATCH = withApiAuth<{ id: string; itemId: string }>(async (ctx, request, { id, itemId }) => {
  const body = await request.json();
  const input = updateOrderItemModifiersSchema.parse(body);
  const item = await orders.updateItemModifiers(ctx, id, itemId, input);
  return NextResponse.json({ item });
});
