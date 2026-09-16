import { NextResponse } from "next/server";
import { terminal } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

// PRINTING V2 FINAL — LOGIN_AWARE terminal binding, browser side, step 1.
// Returns null (nothing to bind) for a role with no operational print
// mapping (see terminal.operationalPrintRoleFor) — elevated roles never get
// a token here, matching "their login must not silently turn the
// workstation into an all-purpose consumer".
export const POST = withApiAuth(async (ctx) => {
  const intent = await terminal.createTerminalBindIntent(ctx);
  return NextResponse.json({ intent });
});
