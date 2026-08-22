import { NextResponse } from "next/server";
import { modifiers } from "@rcs/domain";
import { createModifierGroupSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const groups = await modifiers.listModifierGroups(ctx);
  return NextResponse.json({ groups });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createModifierGroupSchema.parse(body);
  const group = await modifiers.createModifierGroup(ctx, input);
  return NextResponse.json({ group }, { status: 201 });
});
