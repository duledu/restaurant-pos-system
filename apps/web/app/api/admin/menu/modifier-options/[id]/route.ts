import { NextResponse } from "next/server";
import { modifiers } from "@rcs/domain";
import { updateModifierOptionSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updateModifierOptionSchema.parse(body);
  const option = await modifiers.updateModifierOption(ctx, id, input);
  return NextResponse.json({ option });
});
