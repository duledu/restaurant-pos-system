import { NextResponse } from "next/server";
import { analytics } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";
import { parseReportFilters } from "../../../../../lib/report-filters";

export const GET = withApiAuth(async (ctx, request) => {
  const filters = parseReportFilters(new URL(request.url));
  const insights = await analytics.getInsights(ctx, filters);
  return NextResponse.json({ insights });
});
