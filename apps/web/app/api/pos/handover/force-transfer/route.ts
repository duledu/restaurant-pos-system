import { NextResponse } from "next/server";
import { tableOwnership } from "@rcs/domain";
import { forceTransferTableSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

// MANAGER_FORCED_TRANSFER — gated on isOrderManager inside
// forceTransferTable itself (OWNER/ADMIN/MANAGER), for when the outgoing
// waiter is unavailable to hand off their own tables.
export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = forceTransferTableSchema.parse(body);
  const result = await tableOwnership.forceTransferTable(ctx, input);
  return NextResponse.json(result);
});
