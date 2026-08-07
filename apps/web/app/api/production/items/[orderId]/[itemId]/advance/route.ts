import { NextResponse } from "next/server";
import { z } from "zod";
import { production } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

const bodySchema = z.object({ station: z.enum(["KITCHEN", "BAR"]) });

export const POST = withApiAuth<{ orderId: string; itemId: string }>(async (ctx, request, { orderId, itemId }) => {
  const body = await request.json();
  const { station } = bodySchema.parse(body);
  const item = await production.advanceItemStatus(ctx, orderId, itemId, station);
  return NextResponse.json({ item });
});
