import { NextResponse } from "next/server";
import { orders } from "@rcs/domain";
import { submitOrderSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = submitOrderSchema.parse(body);
  const order = await orders.submitOrder(ctx, id, input);
  return NextResponse.json({ order });
});
