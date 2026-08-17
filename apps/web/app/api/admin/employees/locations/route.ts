import { NextResponse } from "next/server";
import { employees } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const locations = await employees.listAssignableLocations(ctx);
  return NextResponse.json({ locations });
});
