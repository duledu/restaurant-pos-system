import { NextResponse } from "next/server";
import { z } from "zod";
import { inventory } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

const schema = z.object({
  delta:  z.number().refine((n) => n !== 0, "Delta ne može biti nula"),
  reason: z.string().trim().min(1).max(500),
  type:   z.enum(["ADJUSTMENT", "WRITE_OFF"]).default("ADJUSTMENT"),
});

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = schema.parse(body);

  const result =
    input.type === "WRITE_OFF"
      ? await inventory.writeOffStock(ctx, id, { quantity: Math.abs(input.delta), reason: input.reason })
      : await inventory.adjustStock(ctx, id, { delta: input.delta, reason: input.reason });

  return NextResponse.json({ movement: result.movement, currentStock: Number(result.item.currentStock) });
});
