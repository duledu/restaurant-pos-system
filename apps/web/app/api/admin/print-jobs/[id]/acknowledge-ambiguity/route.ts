import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { acknowledgePrintAmbiguitySchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

/**
 * PRINTING P0 — operator reconciliation surface for SUBMISSION_UNKNOWN
 * PrintJobs. See packages/domain/printing/print-service.ts
 * `acknowledgePrintAmbiguity` for the state machine details. The Admin
 * UI surfaces a banner on the WorkstationsPanel for each
 * SUBMISSION_UNKNOWN job in the current shift with two buttons
 * (CONFIRM PRINTED / REPRINT) wired here.
 *
 * `id` is the PrintJob.id (NOT the orderId). Idempotent: a second click
 * with the same `decision` returns the same record (no new audit
 * entry).
 */
export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = acknowledgePrintAmbiguitySchema.parse(body);
  const result = await printing.acknowledgePrintAmbiguity(ctx, id, input);
  return NextResponse.json({ result });
});
