import { NextResponse } from "next/server";
import { shifts } from "@rcs/domain";
import { closeShiftSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = closeShiftSchema.parse(body);
  const shift = await shifts.closeShift(ctx, id, input);
  return NextResponse.json({ shift });
});
