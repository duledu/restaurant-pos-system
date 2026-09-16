import { NextResponse } from "next/server";
import { terminal } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

// PRINTING V2 FINAL — LOGIN_AWARE terminal binding, browser side, step 2.
// Looked up ONLY by the authenticated employee's own id — never accepts or
// trusts a client-supplied workstationId.
//
// REGRESSION FIX — "Poveži ovaj računar" repeated on every login: `status`
// alone cannot tell the browser whether binding is even a relevant concept
// for this login (it's null both when genuinely not-yet-bound AND when the
// restaurant is in CENTRAL_ROUTING/the role has no print mapping, in which
// case there is nothing to bind, ever). `applicable` lets the client learn
// "nothing to do here" from its very FIRST check, instead of only after an
// actual (fruitless) bind attempt — see lib/terminal-binding.ts.
export const GET = withApiAuth(async (ctx) => {
  const [status, applicable] = await Promise.all([terminal.getTerminalStatus(ctx), terminal.isTerminalBindingApplicable(ctx)]);
  return NextResponse.json({ status, applicable });
});
