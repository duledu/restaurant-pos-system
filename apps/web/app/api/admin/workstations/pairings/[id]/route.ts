import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const DELETE = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const pairing = await workstations.cancelPairing(ctx, id);
  return NextResponse.json({ pairing });
});
