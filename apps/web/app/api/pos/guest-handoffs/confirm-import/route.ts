import { NextResponse } from "next/server";
import { guestOrdering } from "@rcs/domain";
import { claimGuestOrderHandoffSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

/**
 * Second half of acceptance — called ONLY after the waiter's client-side
 * import (draft.flush()) has actually confirmed persistence. Never called
 * on a partial/failed import, so a handoff stays importConfirmedAt=null
 * (guest-facing "PROCESSING", retryable) until this succeeds. See
 * guest-order-service.ts confirmGuestOrderImport.
 */
export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = claimGuestOrderHandoffSchema.parse(body);
  await guestOrdering.confirmGuestOrderImport(ctx, input);
  return NextResponse.json({ ok: true });
});
