import { NextResponse } from "next/server";
import { menu } from "@rcs/domain";
import { reorderCategoriesSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = reorderCategoriesSchema.parse(body);
  await menu.reorderCategories(ctx, input);
  return NextResponse.json({ ok: true });
});
