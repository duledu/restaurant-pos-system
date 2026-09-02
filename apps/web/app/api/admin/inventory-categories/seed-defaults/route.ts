import { NextResponse } from "next/server";
import { inventoryCategories } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

/** Idempotent — safe to call repeatedly, never creates duplicates. */
export const POST = withApiAuth(async (ctx) => {
  const categories = await inventoryCategories.seedDefaultInventoryCategories(ctx);
  return NextResponse.json({ categories });
});
