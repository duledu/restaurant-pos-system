import { NextResponse } from "next/server";
import { terminal } from "@rcs/domain";
import { withWorkstationAuth } from "../../../../../lib/api-helpers";

// PRINTING V2 FINAL — LOGIN_AWARE terminal binding, Agent side. Reached
// ONLY via the Agent's own tablecore-print://bind?token=... handler
// (apps/print-agent/Program.cs), authenticated with the Agent's permanent
// bearer credential exactly like poll/heartbeat — never a browser request.
export const POST = withWorkstationAuth(async (wsCtx, request) => {
  const body = await request.json();
  const result = await terminal.consumeTerminalBind(wsCtx, body);
  return NextResponse.json(result);
});
