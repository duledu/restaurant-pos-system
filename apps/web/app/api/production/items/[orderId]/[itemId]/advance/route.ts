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
  try {
    const item = await production.advanceItemStatus(ctx, orderId, itemId, station, expectedStatus);
    return NextResponse.json({ item });
  } catch (err) {
    // Physical QA follow-up — a stale-status conflict is a distinct,
    // expected race (another tap/device/poll already moved this item),
    // not a generic failure. 409 lets the KDS client auto-reconcile
    // instead of showing "osveži prikaz" as a dead-end error (see
    // KdsClient.tsx advance()). withApiAuth's outer catch still handles
    // every other error exactly as before.
    if (err instanceof production.StaleItemStatusError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
});
