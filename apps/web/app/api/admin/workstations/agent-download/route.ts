import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const info = workstations.getAgentDownloadInfo(ctx);
  return NextResponse.json(info);
});
