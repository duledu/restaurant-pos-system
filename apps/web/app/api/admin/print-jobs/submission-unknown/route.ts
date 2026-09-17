import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

/**
 * PRINTING P0 — list PrintJobs currently stuck in SUBMISSION_UNKNOWN
 * awaiting an operator decision. Powers the dedicated reconciliation
 * banner on the Admin WorkstationsPanel so a ticket whose physical
 * outcome is uncertain is NEVER silently lost. Scoped to the current
 * shift (most recent 12 hours) — older jobs are visible in the audit
 * stream but are not surfaced as "awaiting decision" to avoid drowning
 * the operator in ancient history.
 */
export const GET = withApiAuth(async (ctx) => {
  const jobs = await printing.listSubmissionUnknownJobs(ctx);
  return NextResponse.json({ jobs });
});
