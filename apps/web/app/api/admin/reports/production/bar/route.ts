import { NextResponse } from "next/server";
import { reporting } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";
import { parseReportFilters } from "../../../../../../lib/report-filters";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const filters = parseReportFilters(url);
  const report = await reporting.getBarProductionReport(ctx, filters);
  return NextResponse.json(report);
});
