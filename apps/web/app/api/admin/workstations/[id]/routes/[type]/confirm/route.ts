import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

/**
 * PRINTING P0 — Admin-side counterpart of the Setup wizard's HUMAN
 * CONFIRMATION step. The Admin "Test" button in the WorkstationsPanel
 * now drives BOTH the technical test (server-side) AND the human
 * confirmation (this endpoint) in one click — so an already-paired PC
 * that just upgraded to commit 336783b can have its routes brought to
 * the new "READY" state without needing to re-open the Setup wizard
 * and without breaking the wizard's "do not auto-launch on upgrade"
 * contract. The endpoint is identical in semantics to the Agent's
 * POST /api/agent/routes/{type}/confirm-physical — both call
 * `workstations.confirmPhysicalTestByAgent` server-side. The only
 * difference is who authenticates: the Agent (bearer credential on its
 * own workstation) vs an Admin employee (ctx.employeeId).
 *
 * Authorization is gated by the same Admin permission check on the
 * route's workstation+location, so a Manager in one location cannot
 * confirm physical printing for a workstation in another.
 */
export const POST = withApiAuth<{ id: string; type: string }>(async (ctx, _request, { id, type }) => {
  const route = await workstations.confirmPhysicalTestByAdmin(ctx, id, type as "KITCHEN" | "BAR" | "RECEIPT");
  return NextResponse.json({ route });
});
