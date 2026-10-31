import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { agentTestPrintResultSchema } from "@rcs/shared";
import { withWorkstationAuth } from "../../../../../lib/api-helpers";
import { traceTestDelivery } from "../../../../../lib/print-delivery-trace";

// Authenticated, request-scoped acknowledgment. Replays are harmless; only
// the currently claimed test can change state. No synthetic restaurant order.
export const POST = withWorkstationAuth(async (wsCtx, request) => {
  const startedAt = performance.now();
  const body = await request.json().catch(() => ({}));
  const input = agentTestPrintResultSchema.parse(body);
  await workstations.recordTestPrintResult(wsCtx, input);
  traceTestDelivery("test_ack", wsCtx.workstationId, input.requestId, "RECEIVED_IDEMPOTENT", startedAt);
  return NextResponse.json({ ok: true });
});
