import { NextResponse } from "next/server";
import { billing } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const bill = await billing.getBillPreview(ctx, id);
  return NextResponse.json(bill);
});

export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const bill = await billing.requestBill(ctx, id);
  return NextResponse.json(bill);
});
