import { NextResponse } from "next/server";
import { z } from "zod";
import { inventory } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

const schema = z.object({
  method: z.enum(["NO_TRACKING", "DIRECT_STOCK", "RECIPE"]),
  confirmSwitchAwayFromDirectStock: z.boolean().optional(),
  confirmReactivateDirectStock: z.boolean().optional(),
});

/**
 * P1.6: eksplicitna promena metode praćenja zaliha za JEDAN MenuItem
 * ("Praćenje zaliha" u Meni admin ekranu) — NIKAD izvedena iz MenuCategory,
 * konfiguriše se po artiklu, po restoranu. Vidi inventory-service.ts
 * setInventoryTrackingMethod za bezbednosna pravila (DirectStockStillPresentError
 * / StaleDirectStockQuantityError).
 */
export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = schema.parse(body);
  const item = await inventory.setInventoryTrackingMethod(ctx, id, input.method, {
    confirmSwitchAwayFromDirectStock: input.confirmSwitchAwayFromDirectStock,
    confirmReactivateDirectStock: input.confirmReactivateDirectStock,
  });
  return NextResponse.json({ item });
});
