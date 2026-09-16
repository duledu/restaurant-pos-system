import { NextResponse } from "next/server";
import { terminal } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

// PRINTING V2 FINAL — LOGIN_AWARE terminal binding, browser side, step 2.
// Looked up ONLY by the authenticated employee's own id — never accepts or
// trusts a client-supplied workstationId.
export const GET = withApiAuth(async (ctx) => {
  const status = await terminal.getTerminalStatus(ctx);
  return NextResponse.json({ status });
});
