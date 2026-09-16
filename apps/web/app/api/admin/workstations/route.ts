import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const [list, pendingPairings, printingMode] = await Promise.all([
    workstations.listWorkstations(ctx),
    workstations.listPendingPairings(ctx),
    workstations.getPrintingMode(ctx),
  ]);
  return NextResponse.json({ workstations: list, pendingPairings, printingMode });
});
