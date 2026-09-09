import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { agentTestPrintResultSchema } from "@rcs/shared";
import { withWorkstationAuth } from "../../../../../lib/api-helpers";

/**
 * Faza 2C — agent prijavljuje ishod SVOJE lokalno izvedene testne štampe
 * (pokrenute preko heartbeatTestPrintRequested zastavice). Namerno bez
 * jobId/attemptId — test štampa nikad nije PrintJob red (vidi
 * workstation-service.ts requestTestPrint napomenu).
 */
export const POST = withWorkstationAuth(async (wsCtx, request) => {
  const body = await request.json().catch(() => ({}));
  const input = agentTestPrintResultSchema.parse(body);
  await workstations.recordTestPrintResult(wsCtx, input);
  return NextResponse.json({ ok: true });
});
