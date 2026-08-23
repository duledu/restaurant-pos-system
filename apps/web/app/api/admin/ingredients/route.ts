import { NextResponse } from "next/server";
import { z } from "zod";
import { ingredients } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

const UNITS = ["KILOGRAM", "GRAM", "LITER", "MILLILITER", "PIECE"] as const;

export const GET = withApiAuth(async (ctx, request) => {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("locationId") ?? undefined;
  const search = searchParams.get("search") ?? undefined;
  const activeOnly = searchParams.get("activeOnly") === "true";
  const category = searchParams.get("category") ?? undefined;
  const items = await ingredients.listIngredients(ctx, locationId, { search, activeOnly, category });
  return NextResponse.json({ ingredients: items });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  unit: z.enum(UNITS),
  category: z.string().trim().max(60).optional(),
  sku: z.string().trim().max(60).optional(),
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createSchema.parse(body);
  const ingredient = await ingredients.createIngredient(ctx, input);
  return NextResponse.json({ ingredient }, { status: 201 });
});
