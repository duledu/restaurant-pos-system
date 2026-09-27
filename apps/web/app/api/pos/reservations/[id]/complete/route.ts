import { NextResponse } from "next/server";
import { reservations } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const reservation = await reservations.completeReservation(ctx, id);
  return NextResponse.json({ reservation });
});
