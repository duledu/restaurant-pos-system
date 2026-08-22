import { NextResponse } from "next/server";
import { modifiers } from "@rcs/domain";
import { updateModifierGroupSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updateModifierGroupSchema.parse(body);
  const group = await modifiers.updateModifierGroup(ctx, id, input);
  return NextResponse.json({ group });
});
