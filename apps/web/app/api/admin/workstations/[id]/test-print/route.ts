import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { printRouteTypeSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json().catch(() => ({}));
  const type = printRouteTypeSchema.parse(body.type);
  const workstation = await workstations.requestTestPrint(ctx, id, type);
  return NextResponse.json({ workstation });
});
