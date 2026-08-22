import { NextResponse } from "next/server";
import { antifraud } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";
import { parseReportFilters } from "../../../../../lib/report-filters";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const filters = parseReportFilters(url);
  const rows = await antifraud.getVoidEvents(ctx, filters);
  return NextResponse.json({ rows });
});
