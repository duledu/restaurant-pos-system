import { NextResponse } from "next/server";
import { production } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string; itemId: string }>(async (ctx, _request, { id, itemId }) => {
  const item = await production.confirmPickup(ctx, id, itemId);
  return NextResponse.json({ item });
});
