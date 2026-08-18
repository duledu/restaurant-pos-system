import { NextResponse } from "next/server";
import { billing } from "@rcs/domain";
import { applyOrderDiscountSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = applyOrderDiscountSchema.parse(body);
  const order = await billing.applyOrderDiscount(ctx, id, input);
  return NextResponse.json({ order });
});
