import { NextResponse } from "next/server";
import { devices } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const locations = await devices.listAssignableLocations(ctx);
  return NextResponse.json({ locations });
});
