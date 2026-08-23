import { NextResponse } from "next/server";
import { z } from "zod";
import { recipes } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

const updateLineSchema = z.object({ quantity: z.number().positive() });

export const PATCH = withApiAuth<{ id: string; lineId: string }>(async (ctx, request, { lineId }) => {
  const body = await request.json();
  const input = updateLineSchema.parse(body);
  const line = await recipes.updateRecipeLine(ctx, lineId, input);
  return NextResponse.json({ line });
});

export const DELETE = withApiAuth<{ id: string; lineId: string }>(async (ctx, _request, { lineId }) => {
  await recipes.removeRecipeLine(ctx, lineId);
  return NextResponse.json({ removed: true });
});
