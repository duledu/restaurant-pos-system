import { NextResponse } from "next/server";
import { z } from "zod";
import { inventoryCategories } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

const renameSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = renameSchema.parse(body);
  const category = await inventoryCategories.renameInventoryCategory(ctx, id, input.name);
  return NextResponse.json({ category });
});
