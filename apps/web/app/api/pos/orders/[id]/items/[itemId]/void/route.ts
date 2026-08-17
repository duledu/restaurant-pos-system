import { NextResponse } from "next/server";
import { voids } from "@rcs/domain";
import { voidOrderItemSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string; itemId: string }>(async (ctx, request, { id, itemId }) => {
  const body = await request.json();
  const input = voidOrderItemSchema.parse(body);
  const voidRecord = await voids.voidOrderItem(ctx, id, itemId, input);
  return NextResponse.json({ void: voidRecord });
});
