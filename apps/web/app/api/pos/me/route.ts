import { NextResponse } from "next/server";
import { withApiAuth } from "../../../../lib/api-helpers";

// PERF: firstName/lastName already come from requireAuth()'s own Employee
// lookup (packages/auth/rbac.ts) — this route used to run a second,
// redundant prisma.employee.findUnique for data already in memory. Now
// zero extra DB queries beyond what requireAuth itself already pays.
export const GET = withApiAuth(async (ctx) => {
  return NextResponse.json({
    employeeId: ctx.employeeId,
    firstName: ctx.firstName ?? null,
    lastName: ctx.lastName ?? null,
    restaurantId: ctx.restaurantId,
    locationIds: ctx.locationIds,
    roles: ctx.roles,
  });
});
