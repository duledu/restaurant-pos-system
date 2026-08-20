import { NextResponse } from "next/server";
import { production } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  const orders = await production.listCompletedStationOrders(ctx, locationId, "BAR");
  return NextResponse.json({ orders });
});
