import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { startPrintSubmissionSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string; jobId: string }>(async (ctx, request, { id, jobId }) => {
  const { attemptId } = startPrintSubmissionSchema.parse(await request.json());
  const printJob = await printing.startPrintSubmission(ctx, id, jobId, attemptId);
  return NextResponse.json({ printJob });
});
