import { reportFiltersSchema, type ReportFiltersInput } from "@rcs/shared";

/** Deljeno parsiranje query stringa za sve /api/admin/reports/** rute. */
export function parseReportFilters(url: URL): ReportFiltersInput {
  return reportFiltersSchema.parse({
    locationId: url.searchParams.get("locationId") ?? undefined,
    preset: url.searchParams.get("preset") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    employeeId: url.searchParams.get("employeeId") ?? undefined,
  });
}
