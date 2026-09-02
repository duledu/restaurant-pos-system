import { NextResponse } from "next/server";
import { z } from "zod";
import { ingredients } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

const schema = z.object({ threshold: z.number().min(0).nullable() });

export const PATCH = withApiAuth<{ stockId: string }>(async (ctx, request, { stockId }) => {
  const body = await request.json();
  const { threshold } = schema.parse(body);
  const stock = await ingredients.setLowStockThreshold(ctx, stockId, threshold);
  return NextResponse.json({ stock });
});
