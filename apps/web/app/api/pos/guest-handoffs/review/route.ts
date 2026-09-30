import { NextResponse } from "next/server";
import { guestOrdering } from "@rcs/domain";
import { guestOrderTokenSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

/** Read-only — "SCAN ≠ CLAIM" (spec). Never mutates the handoff. */
export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = guestOrderTokenSchema.parse(body);
  const snapshot = await guestOrdering.reviewGuestOrderHandoff(ctx, input.token);
  return NextResponse.json(snapshot);
});
