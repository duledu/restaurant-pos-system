import { NextResponse } from "next/server";
import { z } from "zod";
import { ingredients } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

const schema = z.object({
  delta: z.number().refine((v) => v !== 0, "Delta ne može biti nula"),
  reason: z.string().trim().min(1).max(500),
});

export const POST = withApiAuth<{ stockId: string }>(async (ctx, request, { stockId }) => {
  const body = await request.json();
  const input = schema.parse(body);
  const result = await ingredients.adjustStock(ctx, stockId, input);
  return NextResponse.json({ movement: result.movement, currentStock: result.after });
});
