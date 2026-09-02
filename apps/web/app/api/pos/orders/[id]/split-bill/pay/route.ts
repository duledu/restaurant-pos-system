import { NextResponse } from "next/server";
import { splitBilling } from "@rcs/domain";
import { splitBillPaySchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = splitBillPaySchema.parse(body);
  const result = await splitBilling.paySplitBill(ctx, id, input);
  return NextResponse.json(result);
});
