import { NextResponse } from "next/server";
import { menu } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

// P0.2b — jeftina provera statičke verzije menija (Instant Waiter Engine).
// `version` je BROJ (stabilan, poverljiv) ili `null` (Redis/infrastruktura
// nedostupna/nepoznato) — NIKAD 0 za "nepoznato" (vidi menu.getMenuVersion).
// Klijent MORA tretirati `null` isto kao "verzija se promenila" (pun
// refresh), nikad kao "bezbedno je isto kao ranije".
export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  const version = await menu.getWaiterMenuVersion(ctx, locationId);
  return NextResponse.json({ version });
});
