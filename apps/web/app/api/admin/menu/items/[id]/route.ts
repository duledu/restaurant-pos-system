import { NextResponse } from "next/server";
import { menu } from "@rcs/domain";
import { updateMenuItemSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updateMenuItemSchema.parse(body);
  const item = await menu.updateMenuItem(ctx, id, input);
  return NextResponse.json({ item });
});

export const DELETE = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  await menu.deleteMenuItem(ctx, id);
  return NextResponse.json({ ok: true });
});
