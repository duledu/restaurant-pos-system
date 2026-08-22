import { NextResponse } from "next/server";
import { z } from "zod";
import { modifiers } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

const bodySchema = z.object({ isActive: z.boolean() });

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const { isActive } = bodySchema.parse(body);
  const group = await modifiers.setModifierGroupActive(ctx, id, isActive);
  return NextResponse.json({ group });
});
