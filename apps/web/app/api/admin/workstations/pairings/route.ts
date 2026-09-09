import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { createWorkstationPairingSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createWorkstationPairingSchema.parse(body);
  const pairing = await workstations.createPairing(ctx, input);
  return NextResponse.json({ pairing }, { status: 201 });
});
