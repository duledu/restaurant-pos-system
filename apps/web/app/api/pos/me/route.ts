import { NextResponse } from "next/server";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  return NextResponse.json({
    employeeId: ctx.employeeId,
    restaurantId: ctx.restaurantId,
    locationIds: ctx.locationIds,
    roles: ctx.roles,
  });
});
