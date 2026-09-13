import { NextResponse } from "next/server";
import { menu } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

// P0.2b — dedikovan, MALI live-overlay endpoint (Instant Waiter Engine).
// Vraća ISKLJUČIVO stock/receptura/operativna dostupnost po menuItemId —
// NIKAD ime/cenu/porez/kategoriju/dodatke (ta polja su u /api/pos/menu/
// snapshot). Zamenjuje privremeno ponovno korišćenje /api/admin/menu/items
// od strane P0.1b šift-pripreme. Autoritativna logika je 100% ista kao
// postojeći Admin/Order put (menu.getWaiterAvailabilityOverlay poziva ISTU
// computeLiveOverlay funkciju koju listMenuItems koristi) — ovde je samo
// vraćena samostalno, bez punog artikal payload-a oko nje.
export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  const overlay = await menu.getWaiterAvailabilityOverlay(ctx, locationId);
  return NextResponse.json(overlay);
});
