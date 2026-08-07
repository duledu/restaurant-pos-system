import { NextResponse } from "next/server";
import { orders } from "@rcs/domain";
import { addOrderItemSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = addOrderItemSchema.parse(body);
  const item = await orders.addItem(ctx, id, input);
  return NextResponse.json({ item }, { status: 201 });
});
