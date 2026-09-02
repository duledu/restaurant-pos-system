import { NextResponse } from "next/server";
import { splitBilling } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

/** Istorija svih (delimičnih ili jednokratnih) uplata za ovu porudžbinu. */
export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const payments = await splitBilling.listOrderPayments(ctx, id);
  return NextResponse.json({ payments });
});
