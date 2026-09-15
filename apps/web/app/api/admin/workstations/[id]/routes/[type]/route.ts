import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { upsertPrintRouteSchema, printRouteTypeSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

export const PUT = withApiAuth<{ id: string; type: string }>(async (ctx, request, { id, type }) => {
  const routeType = printRouteTypeSchema.parse(type);
  const body = await request.json();
  const input = upsertPrintRouteSchema.parse(body);
  const route = await workstations.upsertPrintRoute(ctx, id, routeType, input);
  return NextResponse.json({ route });
});
