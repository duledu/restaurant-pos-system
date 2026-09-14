import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { updateWorkstationSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updateWorkstationSchema.parse(body);
  const workstation = await workstations.updateWorkstation(ctx, id, input);
  return NextResponse.json({ workstation });
});
