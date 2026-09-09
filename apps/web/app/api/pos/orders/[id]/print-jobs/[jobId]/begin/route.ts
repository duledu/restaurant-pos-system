import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string; jobId: string }>(async (ctx, request, { id, jobId }) => {
  if (request.headers.get("X-TableCore-Print-Protocol") !== "2") {
    return NextResponse.json({ error: "Osvežite aplikaciju pre štampe (print protocol 2)." }, { status: 426 });
  }
  const printJob = await printing.beginPrintAttempt(ctx, id, jobId);
  if (!printJob) {
    return NextResponse.json({ error: "Tiket je već preuzet za štampu" }, { status: 409 });
  }
  return NextResponse.json({ printJob });
});
