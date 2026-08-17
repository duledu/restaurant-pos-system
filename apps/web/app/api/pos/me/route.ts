import { NextResponse } from "next/server";
import { prisma } from "@rcs/db";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const employee = await prisma.employee.findUnique({
    where: { id: ctx.employeeId },
    select: { firstName: true, lastName: true },
  });
  return NextResponse.json({
    employeeId: ctx.employeeId,
    firstName: employee?.firstName ?? null,
    lastName: employee?.lastName ?? null,
    restaurantId: ctx.restaurantId,
    locationIds: ctx.locationIds,
    roles: ctx.roles,
  });
});
