import { NextResponse } from "next/server";
import { orders } from "@rcs/domain";
import { openOrderSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../lib/api-helpers";

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = openOrderSchema.parse(body);
  const order = await orders.openOrder(ctx, input);
  return NextResponse.json({ order }, { status: 201 });
});
