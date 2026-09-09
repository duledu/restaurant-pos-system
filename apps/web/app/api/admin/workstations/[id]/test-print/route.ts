import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const workstation = await workstations.requestTestPrint(ctx, id);
  return NextResponse.json({ workstation });
});
