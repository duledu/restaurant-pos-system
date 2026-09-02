import { NextResponse } from "next/server";
import { inventura } from "@rcs/domain";
import { startInventoryCountSessionSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("locationId") ?? undefined;
  const sessions = await inventura.listSessions(ctx, { locationId });
  return NextResponse.json({ sessions });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = startInventoryCountSessionSchema.parse(body);
  const session = await inventura.startOrResumeSession(ctx, input);
  return NextResponse.json({ session }, { status: 201 });
});
