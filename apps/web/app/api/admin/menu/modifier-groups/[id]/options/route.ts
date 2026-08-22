import { NextResponse } from "next/server";
import { modifiers } from "@rcs/domain";
import { createModifierOptionSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = createModifierOptionSchema.parse(body);
  const option = await modifiers.createModifierOption(ctx, id, input);
  return NextResponse.json({ option }, { status: 201 });
});
