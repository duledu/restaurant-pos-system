import { NextResponse } from "next/server";
import { reservations } from "@rcs/domain";
import { createReservationSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  const date = url.searchParams.get("date");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  if (!date) return NextResponse.json({ error: "date je obavezan (GGGG-MM-DD)" }, { status: 400 });
  const items = await reservations.listReservationsForDate(ctx, locationId, date);
  return NextResponse.json({ reservations: items });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createReservationSchema.parse(body);
  try {
    const reservation = await reservations.createReservation(ctx, input);
    return NextResponse.json({ reservation }, { status: 201 });
  } catch (err) {
    if (err instanceof reservations.ReservationConflictError) {
      return NextResponse.json({ error: err.message, conflict: true }, { status: 409 });
    }
    throw err;
  }
});
