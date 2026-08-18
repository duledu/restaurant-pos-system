import { NextResponse } from "next/server";
import { analytics } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";
import { parseReportFilters } from "../../../../../lib/report-filters";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const filters = parseReportFilters(url);
  const limitParam = Number(url.searchParams.get("limit"));
  const result = await analytics.getTopAndLowItems(ctx, filters, { limit: Number.isFinite(limitParam) ? limitParam : undefined });
  return NextResponse.json(result);
});
