import { NextResponse } from "next/server";
import { reporting } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const locations = await reporting.listAccessibleLocations(ctx);
  return NextResponse.json({ locations });
});
