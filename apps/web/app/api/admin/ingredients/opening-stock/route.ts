import { NextResponse } from "next/server";
import { z } from "zod";
import { ingredients } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

const schema = z.object({
  locationId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        ingredientId: z.string().uuid(),
        quantity: z.number().min(0), // decimal, unlike finished-goods (kg/l/ml can be fractional)
      })
    )
    .min(1),
  reason: z.string().trim().max(500).optional(),
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = schema.parse(body);
  const result = await ingredients.bulkSetIngredientOpeningStock(ctx, input);
  return NextResponse.json(result);
});
