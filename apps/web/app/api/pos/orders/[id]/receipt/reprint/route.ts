import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { reprintReceiptSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = reprintReceiptSchema.parse(body);
  const printJob = await printing.reprintReceipt(ctx, id, input.idempotencyKey);
  return NextResponse.json({ printJob });
});
