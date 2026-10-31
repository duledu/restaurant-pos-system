import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { withWorkstationAuth } from "../../../../lib/api-helpers";

// Read-only: unlike poll/heartbeat this never claims, expires or updates a job.
// Identity is always derived from the bearer credential, never query parameters.
export const GET = withWorkstationAuth(async (ctx, request) => NextResponse.json({
  serverOrigin: new URL(request.url).origin,
  testPrintProtocol: 2,
  release: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
  workstation: await workstations.getAgentDiagnostics(ctx),
}, { headers: { "Cache-Control": "no-store" } }));
