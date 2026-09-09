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
  const result = await workstations.recordHeartbeat(wsCtx, input);
  return NextResponse.json({ ok: true, testPrintRequested: result.testPrintRequested });
});
