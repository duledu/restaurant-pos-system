import { NextResponse } from "next/server";
import { menu } from "@rcs/domain";
import { createCategorySchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const categories = await menu.listCategories(ctx);
  return NextResponse.json({ categories });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createCategorySchema.parse(body);
  const category = await menu.createCategory(ctx, input);
  return NextResponse.json({ category }, { status: 201 });
});
