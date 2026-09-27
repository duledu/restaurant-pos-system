import { NextResponse } from "next/server";
import { reservations } from "@rcs/domain";
import { cancelReservationSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json().catch(() => ({}));
  const { reason } = cancelReservationSchema.parse(body);
  const reservation = await reservations.cancelReservation(ctx, id, reason);
  return NextResponse.json({ reservation });
});
