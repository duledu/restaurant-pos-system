import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const printJobs = await printing.listPrintJobs(ctx, id);
  return NextResponse.json({ printJobs });
});
