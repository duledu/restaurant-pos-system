import { NextResponse } from "next/server";
import { z } from "zod";
import { inventoryCategories } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

const schema = z.object({ inventoryCategoryId: z.string().uuid().nullable() });

/** Direct-stock (resale) MenuItem -> InventoryCategory assignment (e.g. Coca-Cola -> ŠANK -> Sokovi). Never affects sale/deduction. */
export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = schema.parse(body);
  const item = await inventoryCategories.setMenuItemInventoryCategory(ctx, id, input.inventoryCategoryId);
  return NextResponse.json({ item });
});
