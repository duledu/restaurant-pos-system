import { NextResponse } from "next/server";
import { shifts } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const summary = await shifts.getShiftSummary(ctx, id);
  return NextResponse.json(summary);
});
