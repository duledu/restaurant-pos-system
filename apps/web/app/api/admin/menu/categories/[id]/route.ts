import { NextResponse } from "next/server";
import { menu } from "@rcs/domain";
import { updateCategorySchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updateCategorySchema.parse(body);
  const category = await menu.updateCategory(ctx, id, input);
  return NextResponse.json({ category });
});

export const DELETE = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "true";
  await menu.deleteCategory(ctx, id, force);
  return NextResponse.json({ ok: true });
});
