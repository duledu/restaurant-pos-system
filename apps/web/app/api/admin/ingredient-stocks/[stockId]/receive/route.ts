import { NextResponse } from "next/server";
import { z } from "zod";
import { ingredients } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

const schema = z.object({
  quantity: z.number().positive(),
  reason: z.string().trim().max(500).optional(),
});

export const POST = withApiAuth<{ stockId: string }>(async (ctx, request, { stockId }) => {
  const body = await request.json();
  const input = schema.parse(body);
  const result = await ingredients.receiveStock(ctx, stockId, input);
  return NextResponse.json({ movement: result.movement, currentStock: result.after });
});
