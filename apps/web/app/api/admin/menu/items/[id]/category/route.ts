import { NextResponse } from "next/server";
import { menu } from "@rcs/domain";
import { moveToCategorySchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = moveToCategorySchema.parse(body);
  const item = await menu.moveToCategory(ctx, id, input);
  return NextResponse.json({ item });
});
