import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { manualStationPrintSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const printJobs = await printing.listPrintJobs(ctx, id);
  return NextResponse.json({ printJobs });
});

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const input = manualStationPrintSchema.parse(await request.json());
  const printJob = await printing.requestStationPrint(ctx, id, input.station, input.idempotencyKey, input.originalJobId);
  return NextResponse.json({ printJob }, { status: 201 });
});
