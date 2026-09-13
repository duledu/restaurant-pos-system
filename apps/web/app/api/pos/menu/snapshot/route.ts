import { NextResponse } from "next/server";
import { menu } from "@rcs/domain";
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
  const snapshot = await menu.getWaiterMenuSnapshot(ctx, locationId, { fresh });
  return NextResponse.json(snapshot);
});
