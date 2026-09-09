import { NextResponse } from "next/server";
import { agentPrinting } from "@rcs/domain";
import { agentPrintResultSchema } from "@rcs/shared";
import { withWorkstationAuth } from "../../../../../../lib/api-helpers";

/**
 * Ishod mora biti vezan za autentifikovanu radnu stanicu + jobId +
 * attemptId (agent-print-service.ts proverava sva tri preko
 * confirmPrintResult, nepromenjeno). NIKAD ne tvrdi fizički papir —
 * SUBMITTED_TO_SPOOLER znači samo da je Windows print API vratio uspeh.
 * Identičan ponovljen ACK je idempotentan (confirmPrintResult vraća
 * postojeći red); suprotstavljen ACK za isti attempt se odbija.
 */
export const POST = withWorkstationAuth<{ jobId: string }>(async (wsCtx, request, { jobId }) => {
  const body = await request.json();
  const input = agentPrintResultSchema.parse(body);
  const job = await agentPrinting.submitResult(wsCtx, jobId, input.attemptId, input.outcome, input.errorMessage);
  return NextResponse.json({ job });
});
