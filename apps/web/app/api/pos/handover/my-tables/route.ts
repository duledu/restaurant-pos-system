import { NextResponse } from "next/server";
import { tableOwnership } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("locationId");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  const tables = await tableOwnership.listMyOpenTables(ctx, locationId);
  return NextResponse.json({ tables });
});
