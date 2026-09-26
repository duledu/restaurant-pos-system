import { NextResponse } from "next/server";
import { tableOwnership } from "@rcs/domain";
import { transferTablesSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

// Self-service claim (incoming waiter, transfers[].newOwnerId === ctx.employeeId
// on every line) AND handoff (outgoing waiter, transfers[].expectedPreviousOwnerId
// === ctx.employeeId, newOwnerId varies per line — can distribute different
// tables to different incoming waiters in one request) both go through this
// one endpoint — see tableOwnership.transferTables's own doc for why a single
// engine covers both directions and why each line is an independent atomic
// transfer rather than one all-or-nothing transaction.
export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = transferTablesSchema.parse(body);
  const result = await tableOwnership.transferTables(ctx, input);
  return NextResponse.json(result);
});
