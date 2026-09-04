import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string; jobId: string }>(async (ctx, _request, { id, jobId }) => {
  const printJob = await printing.beginPrintAttempt(ctx, id, jobId);
  if (!printJob) {
    return NextResponse.json({ error: "Tiket je već preuzet za štampu" }, { status: 409 });
  }
  return NextResponse.json({ printJob });
});
