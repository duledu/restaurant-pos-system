import { NextResponse } from "next/server";
import { z } from "zod";
import { ingredients } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

const UNITS = ["KILOGRAM", "GRAM", "LITER", "MILLILITER", "PIECE"] as const;

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const ingredient = await ingredients.getIngredient(ctx, id);
  return NextResponse.json({ ingredient });
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  unit: z.enum(UNITS).optional(),
  category: z.string().trim().max(60).nullable().optional(),
  sku: z.string().trim().max(60).nullable().optional(),
});

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updateSchema.parse(body);
  const ingredient = await ingredients.updateIngredient(ctx, id, input);
  return NextResponse.json({ ingredient });
});
