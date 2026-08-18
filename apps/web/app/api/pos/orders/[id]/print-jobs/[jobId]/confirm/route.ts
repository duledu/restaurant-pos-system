import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { confirmPrintResultSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string; jobId: string }>(async (ctx, request, { id, jobId }) => {
  const body = await request.json();
  const input = confirmPrintResultSchema.parse(body);
  const printJob = await printing.confirmPrintResult(ctx, id, jobId, input);
  return NextResponse.json({ printJob });
});
