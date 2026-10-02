import { NextResponse } from "next/server";
import { withApiAuth } from "../../../../../lib/api-helpers";

/**
 * Physical QA stop-ship diagnostics (DODAJ NA STO) — best-effort server
 * echo of a client-captured import trace, keyed by correlationId, so a
 * real physical failure is searchable in server/runtime logs without the
 * waiter ever opening DevTools. Deliberately NOT a new observability
 * system: just the same console.error pattern already used elsewhere in
 * this codebase (e.g. the finalize route), which Vercel already captures.
 * Body is whatever order-client.tsx's importScannedItems already built —
 * ids/quantities/outcomes only, never a QR token/PIN/auth material (see
 * its own comment for what it deliberately omits).
 */
export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json().catch(() => null);
  console.error(`[guest-import:${body?.correlationId ?? "unknown"}] restaurant=${ctx.restaurantId}`, JSON.stringify(body));
  return NextResponse.json({ ok: true });
});
