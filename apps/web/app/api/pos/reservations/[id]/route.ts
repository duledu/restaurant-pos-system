import { NextResponse } from "next/server";
import { reservations } from "@rcs/domain";
import { updateReservationSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const reservation = await reservations.getReservation(ctx, id);
  return NextResponse.json({ reservation });
});

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updateReservationSchema.parse(body);
  try {
    const reservation = await reservations.updateReservation(ctx, id, input);
    return NextResponse.json({ reservation });
  } catch (err) {
    if (err instanceof reservations.ReservationConflictError) {
      return NextResponse.json({ error: err.message, conflict: true }, { status: 409 });
    }
    throw err;
  }
});
