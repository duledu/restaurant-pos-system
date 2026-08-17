import { NextResponse } from "next/server";
import { reporting } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";
import { parseReportFilters } from "../../../../../lib/report-filters";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const filters = parseReportFilters(url);
  const onlySuspicious = url.searchParams.get("onlySuspicious") === "true";
  const rows = await reporting.getActivityLog(ctx, { ...filters, onlySuspicious });
  return NextResponse.json({ rows });
});
