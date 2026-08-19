import { NextResponse } from "next/server";
import { z } from "zod";
import { inventory } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

const schema = z.object({
  locationId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        quantity: z.number().int().min(0),
      })
    )
    .min(1),
  reason: z.string().trim().max(500).optional(),
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = schema.parse(body);
  const result = await inventory.bulkSetOpeningStock(ctx, input);
  return NextResponse.json(result);
});
