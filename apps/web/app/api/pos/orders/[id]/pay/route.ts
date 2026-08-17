import { NextResponse } from "next/server";
import { billing } from "@rcs/domain";
import { completePaymentSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = completePaymentSchema.parse(body);
  const result = await billing.completePayment(ctx, id, input);
  return NextResponse.json(result);
});
