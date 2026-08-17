import { NextResponse } from "next/server";
import { billing } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const receipt = await billing.getReceipt(ctx, id);
  return NextResponse.json({ receipt });
});
