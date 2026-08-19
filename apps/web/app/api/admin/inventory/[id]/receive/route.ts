import { NextResponse } from "next/server";
import { z } from "zod";
import { inventory } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

const schema = z.object({
  quantity: z.number().positive(),
  reason:   z.string().trim().max(500).optional(),
});

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = schema.parse(body);
  const result = await inventory.receiveStock(ctx, id, input);
  return NextResponse.json({ movement: result.movement, currentStock: Number(result.item.currentStock) });
});
