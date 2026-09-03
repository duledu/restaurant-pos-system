import { NextResponse } from "next/server";
import { shifts } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const content = await shifts.getShiftReportContent(ctx, id);
  return NextResponse.json({ content });
});
