import { NextResponse } from "next/server";
import { tables } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  const floors = await tables.listTables(ctx, locationId);
  return NextResponse.json({ floors });
});
