import { NextResponse } from "next/server";
import { orders } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const order = await orders.getOrder(ctx, id);
  return NextResponse.json({ order });
});
