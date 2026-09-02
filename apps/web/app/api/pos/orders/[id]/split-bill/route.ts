import { NextResponse } from "next/server";
import { splitBilling } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const preview = await splitBilling.getSplitBillPreview(ctx, id);
  return NextResponse.json(preview);
});
