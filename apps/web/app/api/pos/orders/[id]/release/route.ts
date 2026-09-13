import { NextResponse } from "next/server";
import { orders } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const result = await orders.releaseEmptyTable(ctx, id);
  return NextResponse.json(result);
});
