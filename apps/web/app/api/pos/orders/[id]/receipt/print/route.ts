import { NextResponse } from "next/server";
import { printing } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

// Print Agent physical QA — primary "Štampaj račun" action. Dispatches the
// authoritative RECEIPT PrintJob (idempotent, same key as the automatic
// dispatch at payment time) for the Windows Print Agent to claim and print
// silently. Never a browser print dialog, no request body needed — the
// server derives the deterministic dispatchKey itself (see printReceipt).
export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const printJob = await printing.printReceipt(ctx, id);
  return NextResponse.json({ printJob });
});
