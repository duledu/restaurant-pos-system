import { NextResponse } from "next/server";
import { shifts } from "@rcs/domain";
import { closeShiftSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = closeShiftSchema.parse(body);
  try {
    const shift = await shifts.closeShift(ctx, id, input);
    return NextResponse.json({ shift });
  } catch (err) {
    // Shift Handover V1: surface the specific "you have open tables" case
    // with the actual table list, so the UI can render "PREDAJ STOLOVE"
    // directly instead of just showing an error string.
    if (err instanceof shifts.OwnedOpenTablesError) {
      return NextResponse.json({ error: err.message, myOpenTables: err.tables }, { status: 409 });
    }
    throw err;
  }
});
