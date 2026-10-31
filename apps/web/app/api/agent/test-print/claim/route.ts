import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { agentTestPrintResultSchema } from "@rcs/shared";
import { withWorkstationAuth } from "../../../../../lib/api-helpers";
import { traceTestDelivery } from "../../../../../lib/print-delivery-trace";

export const POST = withWorkstationAuth(async (ctx, request) => {
  const startedAt = performance.now();
  const { requestId } = agentTestPrintResultSchema.pick({ requestId: true }).parse(await request.json());
  const claimed = await workstations.claimTestPrint(ctx, requestId);
  traceTestDelivery("test_claim", ctx.workstationId, requestId, claimed ? "CLAIMED" : "NOT_GRANTED", startedAt);
  return NextResponse.json({ claimed });
});
