import { NextResponse } from "next/server";
import { z } from "zod";
import { inventoryCategories } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const categories = await inventoryCategories.listInventoryCategories(ctx);
  return NextResponse.json({ categories });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createSchema.parse(body);
  const category = await inventoryCategories.createInventoryCategory(ctx, input);
  return NextResponse.json({ category }, { status: 201 });
});
