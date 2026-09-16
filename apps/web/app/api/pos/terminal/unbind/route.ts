import { NextResponse } from "next/server";
import { terminal } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

// PRINTING V2 FINAL — LOGIN_AWARE terminal binding, browser side, logout.
// Idempotent: a caller with no active binding is a normal no-op.
export const POST = withApiAuth(async (ctx) => {
  await terminal.unbindTerminalSession(ctx);
  return NextResponse.json({ ok: true });
});
