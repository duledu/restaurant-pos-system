import { NextResponse } from "next/server";
import { terminal } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

// PRINTING V2 FINAL — LOGIN_AWARE terminal binding, browser side, step 3.
// Rolling TTL refresh only — never re-proves physical co-location (that
// happened once, via the Agent, at bind time). Called on a fixed interval
// while the tab stays open; a closed/crashed tab simply stops calling this,
// so the binding lapses on its own after terminal.TERMINAL_HEARTBEAT_INTERVAL_MS-scale TTL.
export const POST = withApiAuth(async (ctx) => {
  const active = await terminal.heartbeatTerminalSession(ctx);
  return NextResponse.json({ active });
});
