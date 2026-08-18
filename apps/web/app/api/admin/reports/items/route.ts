import { NextResponse } from "next/server";
import { z } from "zod";
import { reporting } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";
import { parseReportFilters } from "../../../../../lib/report-filters";

const stationSchema = z.enum(["ALL", "KITCHEN", "BAR"]).default("ALL");

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const filters = parseReportFilters(url);
  const station = stationSchema.parse(url.searchParams.get("station") ?? "ALL");
  const report = await reporting.getSoldItems(ctx, filters, station);
  return NextResponse.json(report);
});
