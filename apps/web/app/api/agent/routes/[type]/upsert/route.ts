import { NextResponse } from "next/server";
import type { WorkstationAuthContext } from "@rcs/auth";
import { workstations } from "@rcs/domain";
import { upsertPrintRouteSchema } from "@rcs/shared";
import { withWorkstationAuth } from "../../../../../../lib/api-helpers";

/**
 * PRINTING P0 — Setup wizard route-assignment endpoint. The wizard on
 * the restaurant PC needs to be able to write routes server-side
 * without forcing the operator to leave the Setup window and walk to
 * Admin. This endpoint accepts the Agent's bearer credential (same
 * identity as heartbeat / poll / confirm) and delegates to a
 * workstation-auth-scoped upsert that enforces:
 *   - The workstation is the Agent's own (cannot edit a peer's routes).
 *   - The workstation is not revoked.
 *   - The route is for the Agent's own workstation (no other-ws writes).
 *
 * Mirror of POST /api/admin/workstations/[id]/routes/[type]/upsert for
 * employee context. Setup wizard uses this when the operator picks
 * which Windows printer serves each route (KUHINJA / ŠANK / RAČUN); the
 * Admin route stays the canonical path for production reconfiguration.
 */
export const PUT = withWorkstationAuth<{ type: string }>(async (wsCtx: WorkstationAuthContext, request: Request, { type }) => {
  const body = await request.json();
  const input = upsertPrintRouteSchema.parse(body);
  const route = await workstations.upsertPrintRouteByAgent(wsCtx, type as "KITCHEN" | "BAR" | "RECEIPT", input);
  return NextResponse.json({ route });
});

/**
 * PRINTING P0 — DELETE the route assignment for a single type
 * (KUHINJA / ŠANK / RAČUN). The Setup wizard's "no printer for this
 * route" path uses this so the operator can explicitly clear an
 * assignment (e.g. "I don't want to print receipts on this PC").
 * Server-side: deletes the row, not just nulls printerName, so the
 * route no longer appears in heartbeat route lists / Admin panel /
 * Agent's local config.
 */
export const DELETE = withWorkstationAuth<{ type: string }>(async (wsCtx: WorkstationAuthContext, _request: Request, { type }) => {
  await workstations.deletePrintRouteByAgent(wsCtx, type as "KITCHEN" | "BAR" | "RECEIPT");
  return NextResponse.json({ ok: true });
});
