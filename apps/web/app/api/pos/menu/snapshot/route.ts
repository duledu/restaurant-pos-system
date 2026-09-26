import { NextResponse } from "next/server";
import { menu, promotions } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

// P0.1a — statički waiter meni snapshot (Instant Waiter Engine). Vraća
// ISKLJUČIVO kategorije + aktivne artikle sa cenom/porezom/dodacima — NIKAD
// stock/recepturisanu/operativnu dostupnost (vidi menu.getWaiterMenuSnapshot).
// Potpuno aditivno: ne menja /api/admin/menu/items niti bilo koje postojeće
// ponašanje tog endpointa.
//
// P0.2b: odgovor sada uključuje `menuVersion` (broj ili `null`, vidi
// menu.getWaiterMenuSnapshot). `?fresh=1` (opciono) preskače Redis keš i ide
// direktno na Postgres — koristi ga BUDUĆI klijent (P0.2c/P0.3) ISKLJUČIVO
// kad je otkrio da se verzija promenila/nepoznata, da rekonsilijacija nikad
// ne dobije nazad isti zaostali stale Redis unos.
export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  const fresh = url.searchParams.get("fresh") === "1";
  // Snapshot already validates location access (getWaiterMenuSnapshot calls
  // requireLocationAccess) — the promotions rule set below reuses that same
  // validated locationId, no separate authorization needed. Deliberately
  // NOT folded into menu.getWaiterMenuSnapshot itself: that would require
  // menu-service.ts to import from promotions/promotion-service.ts, which
  // already imports menu-service.ts (for invalidateMenuSnapshotCache) —
  // merging here avoids a circular module dependency between the two.
  const [snapshot, promotionRules] = await Promise.all([
    menu.getWaiterMenuSnapshot(ctx, locationId, { fresh }),
    promotions.listActivePromotionRulesForSnapshot(ctx.restaurantId, locationId),
  ]);
  return NextResponse.json({ ...snapshot, restaurantTimezone: promotionRules.timezone, promotions: promotionRules.rules });
});
