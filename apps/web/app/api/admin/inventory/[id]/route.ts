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
  // P1.6: potvrda da administrator svesno isključuje praćenje iako još ima
  // zalihe na stanju (vidi inventory-service.ts DirectStockStillPresentError),
  // odn. da svesno ponovo aktivira praćenje uz postojeći (možda zastareo)
  // zapis (vidi StaleDirectStockQuantityError).
  confirmSwitchAwayFromDirectStock: z.boolean().optional(),
  confirmReactivateDirectStock: z.boolean().optional(),
});

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = patchSchema.parse(body);

  const invItem = await inventory.getInventoryItem(ctx, id);

  if (input.trackStock !== undefined) {
    await inventory.setTrackingEnabled(ctx, invItem.menuItemId, input.trackStock, {
      confirmSwitchAwayFromDirectStock: input.confirmSwitchAwayFromDirectStock,
      confirmReactivateDirectStock: input.confirmReactivateDirectStock,
    });
  }
  if (input.minimumStock !== undefined) {
    await inventory.setMinimumStock(ctx, invItem.menuItemId, input.minimumStock);
  }
  return NextResponse.json({ ok: true });
});
