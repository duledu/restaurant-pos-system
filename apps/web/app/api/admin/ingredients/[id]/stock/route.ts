import { NextResponse } from "next/server";
import { z } from "zod";
import { ingredients } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

const schema = z.object({
  locationId: z.string().uuid(),
  initialStock: z.number().min(0),
  lowStockThreshold: z.number().min(0).optional(),
});

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = schema.parse(body);
  const stock = await ingredients.initializeStock(ctx, { ingredientId: id, ...input });
  return NextResponse.json({ stock }, { status: 201 });
});
