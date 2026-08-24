import { NextResponse } from "next/server";
import { z } from "zod";
import { inventory } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _req, { id }) => {
  const item = await inventory.getInventoryItem(ctx, id);
  return NextResponse.json({ item });
});

const patchSchema = z.object({
  trackStock:   z.boolean().optional(),
  // null je namerno dozvoljeno — eksplicitno "ukloni prag" (vidi
  // inventory-service.ts setMinimumStock), različito od "polje nije poslato".
  minimumStock: z.number().min(0).nullable().optional(),
});

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = patchSchema.parse(body);

  const invItem = await inventory.getInventoryItem(ctx, id);

  if (input.trackStock !== undefined) {
    await inventory.setTrackingEnabled(ctx, invItem.menuItemId, input.trackStock);
  }
  if (input.minimumStock !== undefined) {
    await inventory.setMinimumStock(ctx, invItem.menuItemId, input.minimumStock);
  }
  return NextResponse.json({ ok: true });
});
