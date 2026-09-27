import { NextResponse } from "next/server";
import { reservations } from "@rcs/domain";
import { seatReservationSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json().catch(() => ({}));
  const { tableId } = seatReservationSchema.parse(body);
  const reservation = await reservations.markSeated(ctx, id, tableId ?? null);
  return NextResponse.json({ reservation });
});
