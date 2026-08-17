import { NextResponse } from "next/server";
import { z } from "zod";
import { production } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

const bodySchema = z.object({
  station: z.enum(["KITCHEN", "BAR"]),
  expectedStatus: z.enum(["SUBMITTED", "ACCEPTED", "PREPARING", "READY"]),
});

export const POST = withApiAuth<{ orderId: string; itemId: string }>(async (ctx, request, { orderId, itemId }) => {
  const body = await request.json();
  const { station, expectedStatus } = bodySchema.parse(body);
  const item = await production.advanceItemStatus(ctx, orderId, itemId, station, expectedStatus);
  return NextResponse.json({ item });
});
