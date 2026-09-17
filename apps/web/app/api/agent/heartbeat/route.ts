import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { workstationHeartbeatSchema } from "@rcs/shared";
import { withWorkstationAuth } from "../../../../lib/api-helpers";

/**
 * Autentifikovan preko Authorization: Bearer (withWorkstationAuth) — telo
 * zahteva nikad ne nosi restaurantId/locationId/workstationId, identitet je
 * ISKLJUČIVO iz kredencijala. Prazno telo je validno (goli "još sam živ"
 * heartbeat) — svako polje je opciono, vidi workstationHeartbeatSchema.
 */
export const POST = withWorkstationAuth(async (wsCtx, request) => {
  const body = await request.json().catch(() => ({}));
  const input = workstationHeartbeatSchema.parse(body);
  // PRINTING P0 — in addition to writing the heartbeat and returning the
  // routes, we read back each route's current visibility + physical-
  // confirmation state so the Setup wizard can decide on a single round-
  // trip whether to declare READY. The route list and the visibility
  // state are stored in the SAME `WorkstationPrintRoute` row (no extra
  // table needed); joining them once here is cheaper than a follow-up
  // API call inside the wizard's hot path.
  const [result, routes, routeReadiness] = await Promise.all([
    workstations.recordHeartbeat(wsCtx, input),
    workstations.getAgentRoutes(wsCtx),
    workstations.getRouteReadinessForAgent(wsCtx),
  ]);
  return NextResponse.json({
    ok: true,
    testPrintRequested: result.testPrintRequested,
    testPrintRoute: result.testPrintRoute,
    routes,
    routeReadiness,
  });
});
