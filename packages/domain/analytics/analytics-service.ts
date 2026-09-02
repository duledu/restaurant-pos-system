/**
 * Faza 7 — Business Intelligence / napredna analitika.
 *
 * ČITAJ-SAMO sloj. Svaka funkcija ovde ili POZIVA već postojeću Faza 5/6
 * funkciju (reporting-service.ts / audit-service.ts) za brojeve koji već
 * postoje, ili dodaje ISKLJUČIVO NOVU agregaciju koja do sada nije
 * postojala — nikad ne ponavlja/re-implementira postojeću finansijsku
 * formulu. Payment/Receipt/Order/OrderItem snapshot/OrderItemVoid/Shift
 * ostaju jedini izvor istine; PrintJob i KDS stanje se NIKAD ne koriste za
 * novac (zahtev #20).
 *
 * PERMISIJA: ista "audit.view" kao postojeći izveštaji (OWNER/ADMIN/MANAGER
 * u seed.ts) — namerno se ne uvodi nova permisija, ista logika kao
 * reporting-service.ts (vidi tamošnju napomenu o preranoj apstrakciji).
 * Svaka funkcija ovde prolazi kroz `reporting.resolveContext`, koje samo
 * to i proverava.
 */

import { prisma, Prisma } from "@rcs/db";
import { type AuthContext } from "@rcs/auth";
import * as reporting from "../reporting/reporting-service";
import type { ReportFilters, SoldItemRow, ShiftReportRow, VoidSummaryRow, EmployeeActivityRow, SalesSummary } from "../reporting/reporting-service";
import { resolvePreviousPeriodRange, zonedYMD, addDaysYMD, type DateRange } from "../reporting/date-range";
import { getSuspiciousActivity, resolveEmployeeDisplayNames, type SuspiciousSignal } from "../audit/audit-service";
import { VOID_REASON_LABELS, type VoidReasonCode } from "@rcs/shared";
import { percentChange, decimalToNumber, safeDiv, round2 } from "./analytics-utils";

// ── KPI POREĐENJE (#1, #16) ─────────────────────────────────────────────

export interface KpiComparisonResult {
  current: SalesSummary;
  previous: SalesSummary | null;
  previousAvailable: boolean;
}

export async function getKpiComparison(ctx: AuthContext, filters: ReportFilters): Promise<KpiComparisonResult> {
  const { locationIds, range, currency, timezone, restaurantCreatedAt } = await reporting.resolveContext(ctx, filters);
  const current = await reporting.computeSalesSummaryForRange(ctx, locationIds, range, currency);
  const previousRange = resolvePreviousPeriodRange(filters.preset, timezone, range);
  const previousAvailable = restaurantCreatedAt.getTime() < previousRange.to.getTime();
  const previous = previousAvailable ? await reporting.computeSalesSummaryForRange(ctx, locationIds, previousRange, currency) : null;
  return { current, previous, previousAvailable };
}

// ── TREND PRODAJE (#3) ───────────────────────────────────────────────────

export type TrendGranularity = "hour" | "day" | "month";

export interface TrendPoint {
  bucket: string;
  label: string;
  sales: string;
  orders: number;
}

export interface SalesTrendResult {
  granularity: TrendGranularity;
  currency: string;
  current: TrendPoint[];
  previous: TrendPoint[] | null;
}

function chooseGranularity(range: DateRange): TrendGranularity {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  if (days <= 1.5) return "hour";
  if (days <= 62) return "day";
  return "month";
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "Maj", "Jun", "Jul", "Avg", "Sep", "Okt", "Nov", "Dec"];

function formatBucketLabel(bucket: Date, granularity: TrendGranularity): string {
  if (granularity === "hour") return `${String(bucket.getUTCHours()).padStart(2, "0")}:00`;
  if (granularity === "day") {
    return `${String(bucket.getUTCDate()).padStart(2, "0")}.${String(bucket.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return `${MONTH_LABELS[bucket.getUTCMonth()]} ${bucket.getUTCFullYear()}`;
}

interface TrendRawRow {
  bucket: Date;
  sales: unknown;
  orders: unknown;
}

// FAZA 8: `COUNT(DISTINCT "orderId")` (ne `COUNT(*)`) u sve tri "orders po
// periodu" agregacije ispod (queryTrend, getSalesByHour, getSalesByWeekday) —
// split naplata znači da jedan Payment red više nije garantovano jedna
// porudžbina, pa bi COUNT(*) precenio broj porudžbina (i posledično
// zaniželio averageOrderValue) svaki put kad se ista porudžbina pojavi kao
// više Payment redova u istom periodu/bucket-u. Isti razlog kao
// reporting-service.ts computeSalesSummaryForRange (completedOrders).
async function queryTrend(
  restaurantId: string,
  locationIds: string[],
  range: DateRange,
  timeZone: string,
  granularity: TrendGranularity
): Promise<TrendPoint[]> {
  const rows = await prisma.$queryRaw<TrendRawRow[]>(Prisma.sql`
    SELECT
      date_trunc(${granularity}, "completedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone}) AS bucket,
      COALESCE(SUM("amount"), 0) AS sales,
      COUNT(DISTINCT "orderId")::bigint AS orders
    FROM "payments"
    WHERE "restaurantId" = ${restaurantId}
      AND "locationId" IN (${Prisma.join(locationIds)})
      AND "completedAt" >= ${range.from}
      AND "completedAt" < ${range.to}
    GROUP BY bucket
    ORDER BY bucket ASC
  `);
  return rows.map((r) => ({
    bucket: r.bucket.toISOString(),
    label: formatBucketLabel(r.bucket, granularity),
    sales: round2(Number(r.sales)).toString(),
    orders: Number(r.orders),
  }));
}

/** Uporedivi prethodni period se ne prikazuje za višegodišnje mesečne
 * trendove (npr. 10-godišnji custom opseg) — grafik sa 240 tačaka umesto
 * 120 gubi čitljivost bez prave koristi (zahtev "Do not overload the chart"). */
const MAX_PREVIOUS_SERIES_MS = 366 * 2 * 86_400_000;

export async function getSalesTrend(ctx: AuthContext, filters: ReportFilters): Promise<SalesTrendResult> {
  const { locationIds, range, currency, timezone } = await reporting.resolveContext(ctx, filters);
  const granularity = chooseGranularity(range);
  const current = await queryTrend(ctx.restaurantId, locationIds, range, timezone, granularity);

  let previous: TrendPoint[] | null = null;
  if (range.to.getTime() - range.from.getTime() <= MAX_PREVIOUS_SERIES_MS) {
    const previousRange = resolvePreviousPeriodRange(filters.preset, timezone, range);
    previous = await queryTrend(ctx.restaurantId, locationIds, previousRange, timezone, granularity);
  }
  return { granularity, currency, current, previous };
}

// ── PRODAJA PO SATU / PEAK HOURS (#4) ────────────────────────────────────

export interface HourBucket {
  hour: number;
  label: string;
  sales: string;
  orders: number;
  averageOrderValue: string;
}

export interface SalesByHourResult {
  currency: string;
  hours: HourBucket[];
  peakSalesHour: number | null;
  peakOrderHour: number | null;
}

interface HourRawRow {
  hour: unknown;
  sales: unknown;
  orders: unknown;
}

export async function getSalesByHour(ctx: AuthContext, filters: ReportFilters): Promise<SalesByHourResult> {
  const { locationIds, range, currency, timezone } = await reporting.resolveContext(ctx, filters);
  const rows = await prisma.$queryRaw<HourRawRow[]>(Prisma.sql`
    SELECT
      EXTRACT(HOUR FROM ("completedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}))::int AS hour,
      COALESCE(SUM("amount"), 0) AS sales,
      COUNT(DISTINCT "orderId")::bigint AS orders
    FROM "payments"
    WHERE "restaurantId" = ${ctx.restaurantId}
      AND "locationId" IN (${Prisma.join(locationIds)})
      AND "completedAt" >= ${range.from}
      AND "completedAt" < ${range.to}
    GROUP BY hour
  `);
  const byHour = new Map(rows.map((r) => [Number(r.hour), r]));

  const hours: HourBucket[] = [];
  let peakSalesHour: number | null = null;
  let peakSales = 0;
  let peakOrderHour: number | null = null;
  let peakOrders = 0;
  for (let h = 0; h < 24; h++) {
    const row = byHour.get(h);
    const sales = row ? Number(row.sales) : 0;
    const orders = row ? Number(row.orders) : 0;
    hours.push({
      hour: h,
      label: `${String(h).padStart(2, "0")}–${String((h + 1) % 24).padStart(2, "0")}`,
      sales: round2(sales).toString(),
      orders,
      averageOrderValue: orders > 0 ? round2(sales / orders).toString() : "0",
    });
    if (sales > peakSales) {
      peakSales = sales;
      peakSalesHour = h;
    }
    if (orders > peakOrders) {
      peakOrders = orders;
      peakOrderHour = h;
    }
  }
  return { currency, hours, peakSalesHour, peakOrderHour };
}

// ── PRODAJA PO DANU U NEDELJI (#5) ───────────────────────────────────────

export interface WeekdayBucket {
  isoDay: number;
  label: string;
  totalSales: string;
  totalOrders: number;
  occurrences: number;
  averageSalesPerOccurrence: string;
  averageOrderValue: string;
}

const WEEKDAY_LABELS = ["Ponedeljak", "Utorak", "Sreda", "Četvrtak", "Petak", "Subota", "Nedelja"];
/** Bezbednosna gornja granica broja iteracija (≈ 50 godina) — sprečava
 * beskonačnu petlju ako neko prosledi nekorektno velik opseg. */
const MAX_WEEKDAY_ITERATION_DAYS = 20_000;

function countWeekdayOccurrences(range: DateRange, timeZone: string): number[] {
  const counts = new Array(7).fill(0) as number[];
  let ymd = zonedYMD(range.from, timeZone);
  const endYMD = zonedYMD(range.to, timeZone);
  let guard = 0;
  while (guard < MAX_WEEKDAY_ITERATION_DAYS) {
    const current = Date.UTC(ymd.year, ymd.month - 1, ymd.day);
    const end = Date.UTC(endYMD.year, endYMD.month - 1, endYMD.day);
    if (current >= end) break;
    const weekday = new Date(current).getUTCDay();
    const isoDay = weekday === 0 ? 7 : weekday;
    counts[isoDay - 1] += 1;
    ymd = addDaysYMD(ymd, 1);
    guard += 1;
  }
  return counts;
}

interface WeekdayRawRow {
  isodow: unknown;
  sales: unknown;
  orders: unknown;
}

export async function getSalesByWeekday(ctx: AuthContext, filters: ReportFilters): Promise<WeekdayBucket[]> {
  const { locationIds, range, timezone } = await reporting.resolveContext(ctx, filters);
  const rows = await prisma.$queryRaw<WeekdayRawRow[]>(Prisma.sql`
    SELECT
      EXTRACT(ISODOW FROM ("completedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}))::int AS isodow,
      COALESCE(SUM("amount"), 0) AS sales,
      COUNT(DISTINCT "orderId")::bigint AS orders
    FROM "payments"
    WHERE "restaurantId" = ${ctx.restaurantId}
      AND "locationId" IN (${Prisma.join(locationIds)})
      AND "completedAt" >= ${range.from}
      AND "completedAt" < ${range.to}
    GROUP BY isodow
  `);
  const byDay = new Map(rows.map((r) => [Number(r.isodow), r]));
  const occurrences = countWeekdayOccurrences(range, timezone);

  return WEEKDAY_LABELS.map((label, idx) => {
    const isoDay = idx + 1;
    const row = byDay.get(isoDay);
    const sales = row ? Number(row.sales) : 0;
    const orders = row ? Number(row.orders) : 0;
    const occ = occurrences[idx];
    return {
      isoDay,
      label,
      totalSales: round2(sales).toString(),
      totalOrders: orders,
      occurrences: occ,
      averageSalesPerOccurrence: occ > 0 ? round2(sales / occ).toString() : "0",
      averageOrderValue: orders > 0 ? round2(sales / orders).toString() : "0",
    };
  });
}

// ── KUHINJA NASPRAM ŠANKA (#6) ───────────────────────────────────────────

export interface StationMetrics {
  revenue: string;
  quantity: number;
  voidValue: string;
  voidQuantity: number;
}

export interface StationComparisonResult {
  currency: string;
  kitchen: StationMetrics;
  bar: StationMetrics;
}

export async function getStationComparison(ctx: AuthContext, filters: ReportFilters): Promise<StationComparisonResult> {
  const { locationIds, range, currency } = await reporting.resolveContext(ctx, filters);
  const soldItems = await reporting.getSoldItems(ctx, filters);

  const voidRows = await prisma.orderItemVoid.findMany({
    where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, voidedAt: { gte: range.from, lt: range.to } },
    select: { voidedValue: true, voidedQuantity: true, orderItem: { select: { preparationStation: true } } },
  });

  let kitchenVoidValue = new Prisma.Decimal(0);
  let kitchenVoidQty = 0;
  let barVoidValue = new Prisma.Decimal(0);
  let barVoidQty = 0;
  // Ista KITCHEN_AND_BAR konvencija kao aggregateSoldItems: pripisuje se
  // ISKLJUČIVO kuhinji, nikad oba — sprečava duplo brojanje istog storna.
  for (const v of voidRows) {
    const station = v.orderItem?.preparationStation;
    if (station === "KITCHEN" || station === "KITCHEN_AND_BAR") {
      kitchenVoidValue = kitchenVoidValue.add(v.voidedValue);
      kitchenVoidQty += v.voidedQuantity;
    } else if (station === "BAR") {
      barVoidValue = barVoidValue.add(v.voidedValue);
      barVoidQty += v.voidedQuantity;
    }
  }

  return {
    currency,
    kitchen: {
      revenue: soldItems.summary.kitchenRevenue,
      quantity: soldItems.summary.kitchenQuantity,
      voidValue: kitchenVoidValue.toString(),
      voidQuantity: kitchenVoidQty,
    },
    bar: {
      revenue: soldItems.summary.barRevenue,
      quantity: soldItems.summary.barQuantity,
      voidValue: barVoidValue.toString(),
      voidQuantity: barVoidQty,
    },
  };
}

// ── TOP / NAJSLABIJE PRODAVANI ARTIKLI (#7) ──────────────────────────────

export interface RankedItem extends SoldItemRow {
  percentOfTotal: number;
}

export interface ZeroSaleMenuItem {
  id: string;
  name: string;
  categoryName: string | null;
}

export interface TopAndLowItemsResult {
  currency: string;
  topItems: RankedItem[];
  lowItems: RankedItem[];
  /** #15: rangiranje po KOLIČINI, ne po prometu — top-artikal po prometu
   * (npr. skup specijalitet) ne mora biti i top-artikal po broju prodatih
   * komada (npr. jeftino piće), pa se ne pretpostavlja da su liste iste. */
  topByQuantity: RankedItem[];
  zeroSaleItems: ZeroSaleMenuItem[];
  /** #7: zero-sale lista dolazi iz TRENUTNOG menija (aktivni, neobrisani
   * MenuItem redovi), NIJE istorijski transakcioni podatak — artikal
   * preimenovan posle prodaje se može pogrešno pojaviti ovde (poklapanje
   * je po TRENUTNOM nazivu naspram istorijskog naziva u prodatim stavkama). */
  basedOnCurrentMenu: true;
}

const ALLOWED_LIMITS = new Set([5, 10, 20]);

export async function getTopAndLowItems(
  ctx: AuthContext,
  filters: ReportFilters,
  options: { limit?: number } = {}
): Promise<TopAndLowItemsResult> {
  const limit = options.limit && ALLOWED_LIMITS.has(options.limit) ? options.limit : 10;
  const report = await reporting.getSoldItems(ctx, filters);
  const totalRevenue = decimalToNumber(report.summary.allRevenue);

  const ranked: RankedItem[] = report.rows.map((r) => ({
    ...r,
    percentOfTotal: totalRevenue > 0 ? round2((decimalToNumber(r.totalRevenue) / totalRevenue) * 100) : 0,
  }));
  const topItems = [...ranked].sort((a, b) => decimalToNumber(b.totalRevenue) - decimalToNumber(a.totalRevenue)).slice(0, limit);
  const lowItems = [...ranked].sort((a, b) => decimalToNumber(a.totalRevenue) - decimalToNumber(b.totalRevenue)).slice(0, limit);
  const topByQuantity = [...ranked].sort((a, b) => b.totalQuantity - a.totalQuantity).slice(0, limit);

  const soldNames = new Set(report.rows.map((r) => r.name));
  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId: ctx.restaurantId, deletedAt: null, isActive: true },
    select: { id: true, name: true, category: { select: { name: true } } },
  });
  const zeroSaleItems = menuItems
    .filter((m) => !soldNames.has(m.name))
    .map((m) => ({ id: m.id, name: m.name, categoryName: m.category?.name ?? null }));

  return { currency: report.currency, topItems, lowItems, topByQuantity, zeroSaleItems, basedOnCurrentMenu: true };
}

// ── PERFORMANSE PO KATEGORIJI (#8) ───────────────────────────────────────

export interface CategoryPerformanceRow {
  categoryName: string;
  quantity: number;
  revenue: string;
  percentOfTotal: number;
  averageItemRevenue: string;
}

export interface CategoryPerformanceResult {
  currency: string;
  categories: CategoryPerformanceRow[];
  /** #8: naziv kategorije dolazi iz TRENUTNE MenuCategory relacije (ista
   * poznata kompromisna odluka kao getSoldItems), NE iz istorijskog
   * snapshot-a — preimenovanje kategorije menja prikaz i za stare periode. */
  isLiveCategoryName: true;
}

export async function getCategoryPerformance(ctx: AuthContext, filters: ReportFilters): Promise<CategoryPerformanceResult> {
  const report = await reporting.getSoldItems(ctx, filters);
  const totalRevenue = decimalToNumber(report.summary.allRevenue);

  const byCategory = new Map<string, { qty: number; revenue: number; itemCount: number }>();
  for (const row of report.rows) {
    const key = row.categoryName ?? "Nekategorisano";
    const bucket = byCategory.get(key) ?? { qty: 0, revenue: 0, itemCount: 0 };
    bucket.qty += row.totalQuantity;
    bucket.revenue += decimalToNumber(row.totalRevenue);
    bucket.itemCount += 1;
    byCategory.set(key, bucket);
  }

  const categories = Array.from(byCategory.entries())
    .map(([categoryName, b]) => ({
      categoryName,
      quantity: b.qty,
      revenue: round2(b.revenue).toString(),
      percentOfTotal: totalRevenue > 0 ? round2((b.revenue / totalRevenue) * 100) : 0,
      averageItemRevenue: b.itemCount > 0 ? round2(b.revenue / b.itemCount).toString() : "0",
    }))
    .sort((a, b) => Number(b.revenue) - Number(a.revenue));

  return { currency: report.currency, categories, isLiveCategoryName: true };
}

// ── ZAPOSLENI (#9, #10) ──────────────────────────────────────────────────

/** #9: samo "TOP SALES BY EMPLOYEE" — rangiranje/sortiranje se radi na
 * klijentu nad već vraćenim redovima (nije nova formula), NIKAD prikazano
 * kao "najbolji zaposleni" (zahtev specifikacije — prodaja zavisi od
 * trajanja smene, sekcije, rasporeda i gužve). */
export async function getEmployeePerformance(ctx: AuthContext, filters: ReportFilters): Promise<EmployeeActivityRow[]> {
  return reporting.getEmployeeActivity(ctx, filters);
}

export interface EmployeeNormalizedRow {
  employeeId: string;
  employeeName: string;
  role: string;
  salesPerHour: string | null;
  // FAZA 8: uplate (Payment redovi) po satu koje je zaposleni ZAVRŠIO — ne
  // porudžbine (vidi EmployeeActivityRow.completedPayments).
  paymentsPerHour: string | null;
  voidPercent: number | null;
  discountPercent: number | null;
  approximateHours: string | null;
}

export interface EmployeeNormalizedResult {
  currency: string;
  rows: EmployeeNormalizedRow[];
  /** #10: radni sati NISU stvarna evidencija dolaska/odlaska po zaposlenom
   * (ne postoji u modelu — Shift je po lokaciji/terminalu, ne lični
   * timesheet). Aproksimacija = zbir trajanja ZATVORENIH smena koje je taj
   * zaposleni zatvorio u periodu. Zaposleni koji nije zatvorio nijednu
   * smenu u periodu dobija `null` (nikad izmišljenu vrednost). */
  approximationNote: string;
}

export async function getEmployeeNormalizedMetrics(ctx: AuthContext, filters: ReportFilters): Promise<EmployeeNormalizedResult> {
  const { locationIds, range, currency } = await reporting.resolveContext(ctx, filters);
  const activity = await reporting.getEmployeeActivity(ctx, filters);
  const employeeIds = activity.map((a) => a.employeeId);

  const closedShifts =
    employeeIds.length > 0
      ? await prisma.shift.findMany({
          where: {
            restaurantId: ctx.restaurantId,
            locationId: { in: locationIds },
            status: "CLOSED",
            closedBy: { in: employeeIds },
            closedAt: { gte: range.from, lt: range.to },
          },
          select: { closedBy: true, openedAt: true, closedAt: true },
        })
      : [];

  const hoursByEmployee = new Map<string, number>();
  for (const s of closedShifts) {
    if (!s.closedBy || !s.closedAt) continue;
    const hours = (s.closedAt.getTime() - s.openedAt.getTime()) / 3_600_000;
    hoursByEmployee.set(s.closedBy, (hoursByEmployee.get(s.closedBy) ?? 0) + hours);
  }

  const rows: EmployeeNormalizedRow[] = activity.map((a) => {
    const hours = hoursByEmployee.get(a.employeeId);
    const sales = decimalToNumber(a.sales);
    const voidValue = decimalToNumber(a.voidValue);
    const discountTotal = decimalToNumber(a.discountTotal);
    const voidPercentRaw = safeDiv(voidValue, sales);
    const discountPercentRaw = safeDiv(discountTotal, sales);
    return {
      employeeId: a.employeeId,
      employeeName: a.employeeName,
      role: a.role,
      salesPerHour: hours && hours > 0 ? round2(sales / hours).toString() : null,
      paymentsPerHour: hours && hours > 0 ? round2(a.completedPayments / hours).toString() : null,
      voidPercent: voidPercentRaw !== null ? round2(voidPercentRaw * 100) : null,
      discountPercent: discountPercentRaw !== null ? round2(discountPercentRaw * 100) : null,
      approximateHours: hours ? round2(hours).toString() : null,
    };
  });

  return {
    currency,
    rows,
    approximationNote:
      "Radni sati su aproksimacija — zbir trajanja smena koje je zaposleni ZATVORIO u periodu, ne stvarna evidencija dolaska/odlaska.",
  };
}

// ── STORNA / PONIŠTAVANJA — INTELIGENCIJA (#11) ──────────────────────────

export interface VoidByHourBucket {
  hour: number;
  voidValue: string;
  voidCount: number;
}
export interface VoidByItemRow {
  itemName: string;
  voidedQuantity: number;
  voidedValue: string;
}
export interface VoidByReasonRow {
  reasonCode: VoidReasonCode | string;
  reasonLabel: string;
  count: number;
  value: string;
}

export interface VoidIntelligenceResult {
  currency: string;
  totalVoidValue: string;
  voidCount: number;
  voidPercentOfSales: number | null;
  byEmployee: VoidSummaryRow[];
  byReason: VoidByReasonRow[];
  byItem: VoidByItemRow[];
  byHour: VoidByHourBucket[];
  trendVsPreviousPercent: number | null;
  /** Nikad optužba — samo "neuobičajena aktivnost, preporučuje se pregled"
   * (zahtev #11), doslovno ponovo korišćeno iz Faze 4 audit-service.ts. */
  anomalies: SuspiciousSignal[];
}

const VOID_ANOMALY_CATEGORIES = new Set(["FREQUENT_VOIDS", "HIGH_VALUE_VOID", "REPEATED_VOID_REASON"]);

interface VoidHourRawRow {
  hour: unknown;
  value: unknown;
  count: unknown;
}

export async function getVoidIntelligence(ctx: AuthContext, filters: ReportFilters): Promise<VoidIntelligenceResult> {
  const { locationIds, range, currency, timezone } = await reporting.resolveContext(ctx, filters);

  const [salesSummary, byEmployee, reasonGroups, itemGroups, hourRows, signals] = await Promise.all([
    reporting.getSalesSummary(ctx, filters),
    reporting.getVoidSummaryByEmployee(ctx, filters),
    prisma.orderItemVoid.groupBy({
      by: ["reasonCode"],
      where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, voidedAt: { gte: range.from, lt: range.to } },
      _count: { _all: true },
      _sum: { voidedValue: true },
    }),
    prisma.orderItemVoid.groupBy({
      by: ["itemName"],
      where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, voidedAt: { gte: range.from, lt: range.to } },
      _sum: { voidedQuantity: true, voidedValue: true },
      orderBy: { _sum: { voidedValue: "desc" } },
      take: 20,
    }),
    prisma.$queryRaw<VoidHourRawRow[]>(Prisma.sql`
      SELECT
        EXTRACT(HOUR FROM ("voidedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}))::int AS hour,
        COALESCE(SUM("voidedValue"), 0) AS value,
        COUNT(*)::bigint AS count
      FROM "order_item_voids"
      WHERE "restaurantId" = ${ctx.restaurantId}
        AND "locationId" IN (${Prisma.join(locationIds)})
        AND "voidedAt" >= ${range.from}
        AND "voidedAt" < ${range.to}
      GROUP BY hour
    `),
    getSuspiciousActivity(ctx, { locationId: filters.locationId, since: range.from }),
  ]);

  const previousRange = resolvePreviousPeriodRange(filters.preset, timezone, range);
  const previousVoidAgg = await prisma.orderItemVoid.aggregate({
    where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, voidedAt: { gte: previousRange.from, lt: previousRange.to } },
    _sum: { voidedValue: true },
  });

  const voidCount = reasonGroups.reduce((sum, g) => sum + g._count._all, 0);
  const voidPercentRaw = safeDiv(decimalToNumber(salesSummary.voidTotal), decimalToNumber(salesSummary.totalSales));

  const byHourMap = new Map(hourRows.map((r) => [Number(r.hour), r]));
  const byHour: VoidByHourBucket[] = Array.from({ length: 24 }, (_, h) => {
    const row = byHourMap.get(h);
    return { hour: h, voidValue: row ? round2(Number(row.value)).toString() : "0", voidCount: row ? Number(row.count) : 0 };
  });

  return {
    currency,
    totalVoidValue: salesSummary.voidTotal,
    voidCount,
    voidPercentOfSales: voidPercentRaw !== null ? round2(voidPercentRaw * 100) : null,
    byEmployee,
    byReason: reasonGroups.map((g) => ({
      reasonCode: g.reasonCode,
      reasonLabel: VOID_REASON_LABELS[g.reasonCode as VoidReasonCode] ?? g.reasonCode,
      count: g._count._all,
      value: decimalToNumber(g._sum.voidedValue).toFixed(2),
    })),
    byItem: itemGroups.map((g) => ({
      itemName: g.itemName,
      voidedQuantity: g._sum.voidedQuantity ?? 0,
      voidedValue: decimalToNumber(g._sum.voidedValue).toFixed(2),
    })),
    byHour,
    trendVsPreviousPercent: percentChange(decimalToNumber(salesSummary.voidTotal), decimalToNumber(previousVoidAgg._sum.voidedValue)),
    anomalies: signals.filter((s) => VOID_ANOMALY_CATEGORIES.has(s.category)),
  };
}

// ── POPUSTI — INTELIGENCIJA (#12) ────────────────────────────────────────

export interface DiscountByEmployeeRow {
  employeeId: string;
  employeeName: string;
  discountTotal: string;
  // FAZA 8: broj Payment redova sa popustom (ne broj RAZLIČITIH porudžbina)
  // — jedna porudžbina podeljena na 2 delimične naplate sa popustom broji se
  // kao 2 ovde, ista konvencija kao EmployeeSales.payments.
  paymentCount: number;
}
export interface DiscountByReasonRow {
  reason: string;
  count: number;
  value: string;
}
export interface DiscountHighlightRow {
  orderId: string;
  discountAmount: string;
  discountReason: string | null;
  tableLabel: string;
  completedAt: string;
}

export interface DiscountIntelligenceResult {
  currency: string;
  totalDiscountValue: string;
  discountPercentOfGross: number | null;
  byEmployee: DiscountByEmployeeRow[];
  byReason: DiscountByReasonRow[];
  byHour: { hour: number; value: string }[];
  highestDiscountOrders: DiscountHighlightRow[];
}

interface DiscountHourRawRow {
  hour: unknown;
  value: unknown;
}

export async function getDiscountIntelligence(ctx: AuthContext, filters: ReportFilters): Promise<DiscountIntelligenceResult> {
  const { locationIds, range, currency, timezone } = await reporting.resolveContext(ctx, filters);

  // FAZA 8: sve niže upiti idu DIREKTNO nad Payment (ne više nad
  // Order.payment, koje je uklonjeno zajedno sa @unique — vidi
  // schema.prisma). Svaki Payment nosi SVOJ prorata udeo popusta
  // (Payment.discountAmount) — ovo je JEDINI ispravan izvor za "koliko je
  // popusta dato KADA/KO/ZAŠTO" otkad jedna porudžbina može imati više
  // delimičnih naplata, svaka sa sopstvenim (mogućim) popustom. Grupisanje
  // po `discountReason` (polje na Order, ne na Payment) se radi u JS-u
  // preko `order.discountReason` iz include-a, ne preko Prisma groupBy
  // (koji ne ume da grupiše po relaciji).
  const [salesSummary, discountedPayments, hourRows] = await Promise.all([
    reporting.getSalesSummary(ctx, filters),
    prisma.payment.findMany({
      where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, discountAmount: { not: null }, completedAt: { gte: range.from, lt: range.to } },
      select: {
        discountAmount: true,
        completedBy: true,
        completedAt: true,
        orderId: true,
        order: { select: { discountReason: true, table: { select: { label: true } } } },
      },
    }),
    prisma.$queryRaw<DiscountHourRawRow[]>(Prisma.sql`
      SELECT
        EXTRACT(HOUR FROM (p."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}))::int AS hour,
        COALESCE(SUM(p."discountAmount"), 0) AS value
      FROM "payments" p
      WHERE p."restaurantId" = ${ctx.restaurantId}
        AND p."locationId" IN (${Prisma.join(locationIds)})
        AND p."discountAmount" IS NOT NULL
        AND p."completedAt" >= ${range.from}
        AND p."completedAt" < ${range.to}
      GROUP BY hour
    `),
  ]);

  const byEmployeeMap = new Map<string, { total: number; count: number }>();
  const byReasonMap = new Map<string, { total: number; count: number }>();
  for (const p of discountedPayments) {
    const amount = decimalToNumber(p.discountAmount);

    const employeeBucket = byEmployeeMap.get(p.completedBy) ?? { total: 0, count: 0 };
    employeeBucket.total += amount;
    employeeBucket.count += 1;
    byEmployeeMap.set(p.completedBy, employeeBucket);

    const reason = p.order.discountReason ?? "Bez razloga";
    const reasonBucket = byReasonMap.get(reason) ?? { total: 0, count: 0 };
    reasonBucket.total += amount;
    reasonBucket.count += 1;
    byReasonMap.set(reason, reasonBucket);
  }
  const nameById = await resolveEmployeeDisplayNames(ctx.restaurantId, Array.from(byEmployeeMap.keys()));
  const byEmployee: DiscountByEmployeeRow[] = Array.from(byEmployeeMap.entries())
    .map(([employeeId, b]) => ({
      employeeId,
      employeeName: nameById.get(employeeId)?.name ?? "?",
      discountTotal: round2(b.total).toString(),
      paymentCount: b.count,
    }))
    .sort((a, b) => Number(b.discountTotal) - Number(a.discountTotal));

  const byReason: DiscountByReasonRow[] = Array.from(byReasonMap.entries())
    .map(([reason, b]) => ({ reason, count: b.count, value: round2(b.total).toFixed(2) }))
    .sort((a, b) => Number(b.value) - Number(a.value));

  const byHourMap = new Map(hourRows.map((r) => [Number(r.hour), r]));
  const byHour = Array.from({ length: 24 }, (_, h) => {
    const row = byHourMap.get(h);
    return { hour: h, value: row ? round2(Number(row.value)).toString() : "0" };
  });

  const discountPercentRaw = safeDiv(decimalToNumber(salesSummary.discountTotal), decimalToNumber(salesSummary.grossSales));

  const highestDiscountPayments = [...discountedPayments]
    .sort((a, b) => decimalToNumber(b.discountAmount) - decimalToNumber(a.discountAmount))
    .slice(0, 10);

  return {
    currency,
    totalDiscountValue: salesSummary.discountTotal,
    discountPercentOfGross: discountPercentRaw !== null ? round2(discountPercentRaw * 100) : null,
    byEmployee,
    byReason,
    byHour,
    highestDiscountOrders: highestDiscountPayments.map((p) => ({
      orderId: p.orderId,
      discountAmount: decimalToNumber(p.discountAmount).toFixed(2),
      discountReason: p.order.discountReason,
      tableLabel: p.order.table.label,
      completedAt: p.completedAt.toISOString(),
    })),
  };
}

// ── NAČINI PLAĆANJA (#13) ────────────────────────────────────────────────

export interface PaymentMethodRow {
  method: "CASH" | "CARD";
  amount: string;
  percent: number;
  // FAZA 8: broj Payment redova ovom metodom (ne broj RAZLIČITIH porudžbina)
  // — vidi napomenu uz DiscountByEmployeeRow.paymentCount.
  paymentCount: number;
}

export interface PaymentBreakdownResult {
  currency: string;
  totalSales: string;
  methods: PaymentMethodRow[];
}

export async function getPaymentBreakdown(ctx: AuthContext, filters: ReportFilters): Promise<PaymentBreakdownResult> {
  const { locationIds, range, currency } = await reporting.resolveContext(ctx, filters);
  const grouped = await prisma.payment.groupBy({
    by: ["method"],
    where: { restaurantId: ctx.restaurantId, locationId: { in: locationIds }, completedAt: { gte: range.from, lt: range.to } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const total = grouped.reduce((sum, g) => sum + decimalToNumber(g._sum.amount), 0);
  const methods: PaymentMethodRow[] = grouped.map((g) => ({
    method: g.method,
    amount: decimalToNumber(g._sum.amount).toFixed(2),
    percent: total > 0 ? round2((decimalToNumber(g._sum.amount) / total) * 100) : 0,
    paymentCount: g._count._all,
  }));
  return { currency, totalSales: total.toFixed(2), methods };
}

// ── ANALITIKA SMENA (#14) ────────────────────────────────────────────────

export interface ShiftVarianceHighlight {
  shiftId: string;
  employeeName: string;
  value: string;
}

export interface ShiftAnalyticsResult {
  currency: string;
  shiftCount: number;
  totalSales: string;
  averageSalesPerShift: string;
  totalCashExpected: string;
  totalCashCounted: string;
  averageCashVariance: string;
  largestPositiveVariance: ShiftVarianceHighlight | null;
  largestNegativeVariance: ShiftVarianceHighlight | null;
  shifts: ShiftReportRow[];
}

export async function getShiftAnalytics(ctx: AuthContext, filters: ReportFilters): Promise<ShiftAnalyticsResult> {
  const { currency } = await reporting.resolveContext(ctx, filters);
  const rows = await reporting.getShiftReport(ctx, filters);
  const closed = rows.filter((r) => r.status === "CLOSED" && r.cashDifference !== null);

  const totalSales = rows.reduce((s, r) => s + decimalToNumber(r.totalSales), 0);
  const totalExpected = closed.reduce((s, r) => s + decimalToNumber(r.expectedCash), 0);
  const totalCounted = closed.reduce((s, r) => s + decimalToNumber(r.countedCash), 0);
  const varianceSum = closed.reduce((s, r) => s + decimalToNumber(r.cashDifference), 0);

  let largestPos: ShiftReportRow | null = null;
  let largestNeg: ShiftReportRow | null = null;
  for (const r of closed) {
    const diff = decimalToNumber(r.cashDifference);
    if (diff > 0 && (!largestPos || diff > decimalToNumber(largestPos.cashDifference))) largestPos = r;
    if (diff < 0 && (!largestNeg || diff < decimalToNumber(largestNeg.cashDifference))) largestNeg = r;
  }

  return {
    currency,
    shiftCount: rows.length,
    totalSales: round2(totalSales).toString(),
    averageSalesPerShift: rows.length > 0 ? round2(totalSales / rows.length).toString() : "0",
    totalCashExpected: round2(totalExpected).toString(),
    totalCashCounted: round2(totalCounted).toString(),
    averageCashVariance: closed.length > 0 ? round2(varianceSum / closed.length).toString() : "0",
    largestPositiveVariance: largestPos ? { shiftId: largestPos.id, employeeName: largestPos.employeeName, value: largestPos.cashDifference as string } : null,
    largestNegativeVariance: largestNeg ? { shiftId: largestNeg.id, employeeName: largestNeg.employeeName, value: largestNeg.cashDifference as string } : null,
    shifts: rows,
  };
}

// ── UVIDI / INSIGHTS (#15) — deterministički, BEZ LLM-a ──────────────────

export interface Insight {
  text: string;
  tone: "positive" | "negative" | "neutral";
}

/** Minimalan broj porudžbina da bi se izveo bilo kakav zaključak — ispod
 * ovog praga se uvid PRESKAČE, nikad ne izmišlja (zahtev #15). */
const MIN_SAMPLE_ORDERS = 3;

export async function getInsights(ctx: AuthContext, filters: ReportFilters): Promise<Insight[]> {
  const [kpi, hourly, weekday, stations, voids] = await Promise.all([
    getKpiComparison(ctx, filters),
    getSalesByHour(ctx, filters),
    getSalesByWeekday(ctx, filters),
    getStationComparison(ctx, filters),
    getVoidIntelligence(ctx, filters),
  ]);

  const insights: Insight[] = [];

  if (kpi.previousAvailable && kpi.previous && kpi.current.completedOrders >= MIN_SAMPLE_ORDERS && kpi.previous.completedOrders >= MIN_SAMPLE_ORDERS) {
    const salesChange = percentChange(Number(kpi.current.totalSales), Number(kpi.previous.totalSales));
    if (salesChange !== null) {
      insights.push({
        text: `Prodaja je ${salesChange >= 0 ? "veća" : "manja"} za ${Math.abs(salesChange)}% u odnosu na prethodni uporedivi period.`,
        tone: salesChange >= 0 ? "positive" : "negative",
      });
    }
    const aovChange = percentChange(Number(kpi.current.averageOrderValue), Number(kpi.previous.averageOrderValue));
    if (aovChange !== null) {
      insights.push({
        text: `Prosečna vrednost porudžbine je ${aovChange >= 0 ? "porasla" : "opala"} za ${Math.abs(aovChange)}%.`,
        tone: aovChange >= 0 ? "positive" : "negative",
      });
    }
  }

  if (hourly.peakSalesHour !== null) {
    const bucket = hourly.hours[hourly.peakSalesHour];
    if (bucket.orders >= MIN_SAMPLE_ORDERS) {
      insights.push({ text: `${bucket.label} ima najveći promet u toku dana.`, tone: "neutral" });
    }
  }

  const weekdayWithData = weekday.filter((w) => w.totalOrders >= MIN_SAMPLE_ORDERS);
  if (weekdayWithData.length >= 2) {
    const best = [...weekdayWithData].sort((a, b) => Number(b.totalSales) - Number(a.totalSales))[0];
    insights.push({ text: `${best.label} je dan sa najvećim prometom u izabranom periodu.`, tone: "neutral" });
  }

  const stationTotal = Number(stations.kitchen.revenue) + Number(stations.bar.revenue);
  if (stationTotal > 0) {
    const barPercent = round2((Number(stations.bar.revenue) / stationTotal) * 100);
    insights.push({ text: `Šank učestvuje sa ${barPercent}% u pripisanom prometu.`, tone: "neutral" });
  }

  if (voids.trendVsPreviousPercent !== null && voids.voidCount >= MIN_SAMPLE_ORDERS) {
    insights.push({
      text: `Vrednost storniranih stavki je ${voids.trendVsPreviousPercent >= 0 ? "porasla" : "opala"} za ${Math.abs(voids.trendVsPreviousPercent)}% u odnosu na prethodni period.`,
      tone: voids.trendVsPreviousPercent >= 0 ? "negative" : "positive",
    });
  }

  return insights;
}
