import { NextResponse } from "next/server";
import type { WorkstationAuthContext } from "@rcs/auth";
import { workstations } from "@rcs/domain";
import { agentPhysicalConfirmationSchema } from "@rcs/shared";
import { withWorkstationAuth } from "../../../../../../lib/api-helpers";

/**
 * PRINTING P0 — Setup wizard's HUMAN CONFIRMATION step. The Agent
 * (authenticated via its own bearer credential) calls this when the
 * operator presses "Da, test tiket je uspešno odštampan" for a specific
 * route inside the Setup wizard. The server-side precondition chain
 * (route exists + not revoked + enabled + printerName+paperWidthMm set)
 * lives in `workstations.confirmPhysicalTestByAgent` so the same checks
 * gate both this endpoint and any future caller (Admin UI manual
 * confirmation button, automation tests, etc.).
 */
export const POST = withWorkstationAuth<{ type: string }>(
  async (wsCtx: WorkstationAuthContext, request: Request, { type }) => {
    const body = await request.json().catch(() => ({}));
    const input = agentPhysicalConfirmationSchema.parse({ ...body, type });
    const route = await workstations.confirmPhysicalTestByAgent(wsCtx, input);
    return NextResponse.json({ route });
  }
);
