import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const [list, pendingPairings] = await Promise.all([
    workstations.listWorkstations(ctx),
    workstations.listPendingPairings(ctx),
  ]);
  return NextResponse.json({ workstations: list, pendingPairings });
});
