import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { printRouteTypeSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";
import { traceTestDelivery } from "../../../../../../lib/print-delivery-trace";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const startedAt = performance.now();
  const body = await request.json().catch(() => ({}));
  const type = printRouteTypeSchema.parse(body.type);
  const workstation = await workstations.requestTestPrint(ctx, id, type);
  traceTestDelivery("test_request", id, workstation.testPrintRequestedAt?.toISOString() ?? null,
    workstation.testPrintStatus ?? "UNKNOWN", startedAt);
  return NextResponse.json({ workstation });
});
