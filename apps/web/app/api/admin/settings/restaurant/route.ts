import { NextResponse } from "next/server";
import { settings } from "@rcs/domain";
import { requirePermission } from "@rcs/auth";
import { adminRestaurantSettingsPutSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

// settings.getRestaurantSettings(ctx) itself has NO permission check by
// design — printing (dispatchReceiptPrintJob) reads it internally for ANY
// employee who completes a payment, regardless of their settings.manage
// grant. The admin API route is the correct place to gate the ADMIN VIEW
// of these settings, without touching that shared internal reader.
export const GET = withApiAuth(async (ctx) => {
  requirePermission(ctx, "settings.manage");
  const [restaurantSettings, name] = await Promise.all([
    settings.getRestaurantSettings(ctx),
    settings.getRestaurantName(ctx),
  ]);
  return NextResponse.json({ settings: { ...restaurantSettings, name } });
});

// RECEIPT RENDERING POLISH — `name` belongs to a different table
// (Restaurant, not RestaurantSettings) but is exposed on this same admin
// page/request for a simple one-form editing experience. Split before
// delegating to the two domain functions, each of which independently
// enforces "settings.manage".
export const PUT = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const { name, ...settingsInput } = adminRestaurantSettingsPutSchema.parse(body);
  const [restaurantSettings, updatedName] = await Promise.all([
    settings.updateRestaurantSettings(ctx, settingsInput),
    name === undefined ? settings.getRestaurantName(ctx) : settings.updateRestaurantName(ctx, name),
  ]);
  return NextResponse.json({ settings: { ...restaurantSettings, name: updatedName } });
});
