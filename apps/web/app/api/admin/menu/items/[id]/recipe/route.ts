import { NextResponse } from "next/server";
import { z } from "zod";
import { recipes } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

const addLineSchema = z.object({
  ingredientId: z.string().uuid(),
  quantity: z.number().positive(),
});

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const lines = await recipes.getRecipe(ctx, id);
  return NextResponse.json({ lines });
});

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = addLineSchema.parse(body);
  const line = await recipes.addRecipeLine(ctx, id, input);
  return NextResponse.json({ line }, { status: 201 });
});
