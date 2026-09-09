import { NextResponse } from "next/server";
import { agentPrinting } from "@rcs/domain";
import { agentSubmissionStartSchema } from "@rcs/shared";
import { withWorkstationAuth } from "../../../../../../lib/api-helpers";

/**
 * "Upravo počinjem fizičku pošiljku" — mora prethoditi
 * PrintDocument.Print pozivu na agentu (nikad posle). Ponovo koristi
 * startPrintSubmission (print-service.ts) nepromenjeno preko
 * agent-print-service.ts.
 */
export const POST = withWorkstationAuth<{ jobId: string }>(async (wsCtx, request, { jobId }) => {
  const body = await request.json();
  const input = agentSubmissionStartSchema.parse(body);
  const job = await agentPrinting.beginSubmission(wsCtx, jobId, input.attemptId);
  return NextResponse.json({ job });
});
