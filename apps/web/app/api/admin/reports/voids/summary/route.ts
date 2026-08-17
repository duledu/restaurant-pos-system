import { NextResponse } from "next/server";
import { reporting } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";
import { parseReportFilters } from "../../../../../../lib/report-filters";

export const GET = withApiAuth(async (ctx, request) => {
  const filters = parseReportFilters(new URL(request.url));
  const rows = await reporting.getVoidSummaryByEmployee(ctx, filters);
  return NextResponse.json({ rows });
});
