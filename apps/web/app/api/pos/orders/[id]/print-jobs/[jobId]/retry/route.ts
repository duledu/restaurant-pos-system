import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string; jobId: string }>(async (ctx, _request, { id, jobId }) => {
  const printJob = await printing.retryPrintJob(ctx, id, jobId);
  return NextResponse.json({ printJob });
});
