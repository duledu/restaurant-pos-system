import { NextResponse } from "next/server";
import { z } from "zod";
import { modifiers } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

const attachSchema = z.object({ modifierGroupId: z.string().uuid() });

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const groups = await modifiers.listModifierGroupsForItem(ctx, id);
  return NextResponse.json({ groups });
});

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const { modifierGroupId } = attachSchema.parse(body);
  const link = await modifiers.attachModifierGroupToItem(ctx, id, modifierGroupId);
  return NextResponse.json({ link }, { status: 201 });
});
