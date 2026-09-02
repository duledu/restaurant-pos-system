import { NextResponse } from "next/server";
import { inventura } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string; lineId: string }>(async (ctx, _request, { id, lineId }) => {
  const line = await inventura.recountLine(ctx, id, lineId);
  return NextResponse.json({ line });
});
