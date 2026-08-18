import { NextResponse } from "next/server";
import { settings } from "@rcs/domain";
import { requirePermission } from "@rcs/auth";
import { updateRestaurantSettingsSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

// settings.getRestaurantSettings(ctx) itself has NO permission check by
// design — printing (dispatchReceiptPrintJob) reads it internally for ANY
// employee who completes a payment, regardless of their settings.manage
// grant. The admin API route is the correct place to gate the ADMIN VIEW
// of these settings, without touching that shared internal reader.
export const GET = withApiAuth(async (ctx) => {
  requirePermission(ctx, "settings.manage");
  const restaurantSettings = await settings.getRestaurantSettings(ctx);
  return NextResponse.json({ settings: restaurantSettings });
});

export const PUT = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = updateRestaurantSettingsSchema.parse(body);
  const restaurantSettings = await settings.updateRestaurantSettings(ctx, input);
  return NextResponse.json({ settings: restaurantSettings });
});
