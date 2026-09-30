import { NextResponse } from "next/server";
import { guestOrdering } from "@rcs/domain";
import { claimGuestOrderHandoffSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

/** The ONE mutating step — confirmed "DODAJ NA STO". Atomic conditional claim; see guest-order-service.ts. */
export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = claimGuestOrderHandoffSchema.parse(body);
  const snapshot = await guestOrdering.claimGuestOrderHandoff(ctx, input);
  return NextResponse.json(snapshot);
});
