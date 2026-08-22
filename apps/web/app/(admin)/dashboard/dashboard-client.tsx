"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatMoney } from "@rcs/shared";
import { Card } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import { PageHeader } from "../../../components/ui/PageHeader";
import { KpiCard } from "../../../components/admin/KpiCard";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../components/admin/ReportFilters";
import { ReportPrintHeader } from "../../../components/admin/ReportPrintHeader";
import { SEVERITY_BADGE_TONE, SEVERITY_LABEL, signalCategoryLabel, type Severity } from "../../../components/admin/severity";
import { ROLE_LABEL } from "../../../components/admin/role-labels";
import { TrendLineChart, SalesBarChart, StationBarChart, PaymentDonutChart, type TrendChartPoint, type BarChartDatum, type DonutDatum } from "../../../components/analytics/Charts";

// ── Tipovi (ogledaju JSON odgovore reporting/analytics/antifraud servisa) ──

interface SalesSummary {
  currency: string;
  totalSales: string;
  cashSales: string;
  cardSales: string;
  completedOrders: number;
  averageOrderValue: string;
  grossSales: string;
  netSales: string;
  discountTotal: string;
  taxTotal: string;
  voidTotal: string;
}
interface KpiComparison { current: SalesSummary; previous: SalesSummary | null; previousAvailable: boolean; }
interface TrendResult { granularity: "hour" | "day" | "month"; currency: string; current: { label: string; sales: string }[]; previous: { label: string; sales: string }[] | null; }
interface HourlyResult { currency: string; hours: { hour: number; label: string; sales: string; orders: number; averageOrderValue: string }[]; peakSalesHour: number | null; peakOrderHour: number | null; }
interface WeekdayRow { isoDay: number; label: string; totalSales: string; totalOrders: number; occurrences: number; averageSalesPerOccurrence: string; averageOrderValue: string; }
interface StationResult { currency: string; kitchen: { revenue: string; quantity: number; voidValue: string; voidQuantity: number }; bar: { revenue: string; quantity: number; voidValue: string; voidQuantity: number }; }
interface RankedItem { name: string; categoryName: string | null; totalQuantity: number; totalRevenue: string; percentOfTotal: number; }
interface ItemsResult { currency: string; topItems: RankedItem[]; lowItems: RankedItem[]; topByQuantity: RankedItem[]; zeroSaleItems: { id: string; name: string; categoryName: string | null }[]; basedOnCurrentMenu: true; }
interface CategoryRow { categoryName: string; quantity: number; revenue: string; percentOfTotal: number; averageItemRevenue: string; }
interface CategoriesResult { currency: string; categories: CategoryRow[]; isLiveCategoryName: true; }
interface EmployeeRow { employeeId: string; employeeName: string; role: string; completedOrders: number; sales: string; cashHandled: string; cardHandled: string; averageOrderValue: string; discountTotal: string; voidCount: number; voidValue: string; shiftsClosedCount: number; cashDifference: string | null; }
interface EmployeeNormalizedRow { employeeId: string; employeeName: string; role: string; salesPerHour: string | null; ordersPerHour: string | null; voidPercent: number | null; discountPercent: number | null; approximateHours: string | null; }
interface EmployeeNormalizedResult { currency: string; rows: EmployeeNormalizedRow[]; approximationNote: string; }
interface VoidIntelligence {
  currency: string; totalVoidValue: string; voidCount: number; voidPercentOfSales: number | null;
  byEmployee: { employeeId: string; employeeName: string; role: string; voidCount: number; voidValue: string }[];
  byReason: { reasonCode: string; reasonLabel: string; count: number; value: string }[];
  trendVsPreviousPercent: number | null;
  anomalies: { category: string; severity: Severity; employeeName: string; description: string; occurredAt: string }[];
}
interface DiscountIntelligence {
  currency: string; totalDiscountValue: string; discountPercentOfGross: number | null;
  byEmployee: { employeeId: string; employeeName: string; discountTotal: string; orderCount: number }[];
  byReason: { reason: string; count: number; value: string }[];
  highestDiscountOrders: { orderId: string; discountAmount: string; discountReason: string | null; tableLabel: string; completedAt: string }[];
}
interface PaymentBreakdown { currency: string; totalSales: string; methods: { method: "CASH" | "CARD"; amount: string; percent: number; orderCount: number }[]; }
interface ShiftAnalytics {
  currency: string; shiftCount: number; totalSales: string; averageSalesPerShift: string;
  totalCashExpected: string; totalCashCounted: string; averageCashVariance: string;
  largestPositiveVariance: { shiftId: string; employeeName: string; value: string } | null;
  largestNegativeVariance: { shiftId: string; employeeName: string; value: string } | null;
}
interface Insight { text: string; tone: "positive" | "negative" | "neutral"; }
interface CurrentStatus {
  openTables: number;
  activeOrders: number;
  openShiftsCount: number;
  shiftsOnDuty: { shiftId: string; employeeName: string; role: string; openedAt: string; openingCash: string }[];
  kitchenPendingItems: number;
  barPendingItems: number;
}
interface AntiFraudSignal {
  category: string;
  severity: Severity;
  employeeId?: string;
  employeeName?: string;
  itemName?: string;
  description: string;
  occurredAt: string;
  count?: number;
  value?: string;
}
interface AntiFraudOverview {
  signalsCount: number;
  voidCount: number;
  voidValue: string;
  cashDiscrepancyAbsTotal: string;
  cashDiscrepancyShiftsCount: number;
  inventoryCorrectionsCount: number;
}
interface StockAttentionItem { id: string; name: string; currentStock: string; minimumStock: number | null; unit: string; status: "out" | "low" }
interface StockAttentionSummary { outOfStockCount: number; lowStockCount: number; worstItems: StockAttentionItem[] }

interface DashboardData {
  kpi: KpiComparison;
  trend: TrendResult;
  hourly: HourlyResult;
  weekdays: WeekdayRow[];
  stations: StationResult;
  items: ItemsResult;
  categories: CategoriesResult;
  employees: EmployeeRow[];
  employeesNormalized: EmployeeNormalizedResult;
  voids: VoidIntelligence;
  discounts: DiscountIntelligence;
  payments: PaymentBreakdown;
  shifts: ShiftAnalytics;
  insights: Insight[];
  status: CurrentStatus;
  signals: AntiFraudSignal[];
  antifraud: AntiFraudOverview;
  stock: StockAttentionSummary;
}

type EmployeeSortKey = "sales" | "orders" | "avgOrder";
type ItemLimit = 5 | 10 | 20;

const SEVERITY_ORDER: Record<Severity, number> = { HIGH: 0, WARNING: 1, INFO: 2 };
const INSIGHT_ICON: Record<Insight["tone"], string> = { positive: "↑", negative: "↓", neutral: "•" };
const INSIGHT_COLOR: Record<Insight["tone"], string> = { positive: "text-success", negative: "text-danger", neutral: "text-inkSoft" };

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

// Lagano periodično osvežavanje — isti red veličine kao ostali "uživo"
// prikazi u TableCore-u (KDS/SSE), bez agresivnog 1s pollinga (specifikacija #18).
const AUTO_REFRESH_MS = 60_000;

export function DashboardClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [itemLimit, setItemLimit] = useState<ItemLimit>(10);
  const [employeeSort, setEmployeeSort] = useState<EmployeeSortKey>("sales");
  const [topByQty, setTopByQty] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    const query = reportFiltersToQuery(filters);
    try {
      const [
        kpi, trend, hourly, weekdaysRes, stations, items, categories, employees,
        employeesNormalized, voids, discounts, payments, shifts, insightsRes,
        statusRes, signalsRes, antifraudRes, stockRes,
      ] = await Promise.all([
        apiFetch(`/api/admin/analytics/kpi?${query}`),
        apiFetch(`/api/admin/analytics/trend?${query}`),
        apiFetch(`/api/admin/analytics/hourly?${query}`),
        apiFetch(`/api/admin/analytics/weekday?${query}`),
        apiFetch(`/api/admin/analytics/stations?${query}`),
        apiFetch(`/api/admin/analytics/items?${query}&limit=${itemLimit}`),
        apiFetch(`/api/admin/analytics/categories?${query}`),
        apiFetch(`/api/admin/analytics/employees?${query}`),
        apiFetch(`/api/admin/analytics/employees/normalized?${query}`),
        apiFetch(`/api/admin/analytics/voids?${query}`),
        apiFetch(`/api/admin/analytics/discounts?${query}`),
        apiFetch(`/api/admin/analytics/payments?${query}`),
        apiFetch(`/api/admin/analytics/shifts?${query}`),
        apiFetch(`/api/admin/analytics/insights?${query}`),
        apiFetch(`/api/admin/reports/status?locationId=${filters.locationId}`),
        // P2.3: "Zahteva pažnju" sada koristi P2.2 (period-svesno), ne stari
        // /api/admin/reports/attention koji je uvek gledao fiksnih 30 dana
        // bez obzira na izabrani period — vidi napomenu u finalnom izveštaju.
        apiFetch(`/api/admin/antifraud/signals?${query}`),
        apiFetch(`/api/admin/antifraud/overview?${query}`),
        apiFetch(`/api/admin/inventory/attention?locationId=${filters.locationId}`),
      ]);
      setData({
        kpi, trend, hourly, weekdays: weekdaysRes.weekdays, stations, items, categories,
        employees: employees.rows, employeesNormalized, voids, discounts, payments, shifts,
        insights: insightsRes.insights, status: statusRes, signals: signalsRes.signals,
        antifraud: antifraudRes, stock: stockRes,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju kontrolne table");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, itemLimit]);

  useEffect(() => {
    load();
  }, [load]);

  // Lagano periodično osvežavanje u pozadini (bez skeleton-treperenja) — vidi
  // AUTO_REFRESH_MS napomenu.
  useEffect(() => {
    const id = setInterval(() => {
      load({ silent: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const sortedSignals = useMemo(
    () => (data ? [...data.signals].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) : null),
    [data]
  );
  const sortedEmployees = useMemo(() => {
    if (!data) return [];
    const rows = [...data.employees];
    if (employeeSort === "sales") return rows.sort((a, b) => Number(b.sales) - Number(a.sales));
    if (employeeSort === "orders") return rows.sort((a, b) => b.completedOrders - a.completedOrders);
    return rows.sort((a, b) => Number(b.averageOrderValue) - Number(a.averageOrderValue));
  }, [data, employeeSort]);

  const trendChartData: TrendChartPoint[] = useMemo(() => {
    if (!data) return [];
    return data.trend.current.map((p, i) => ({
      label: p.label,
      current: Number(p.sales),
      previous: data.trend.previous ? Number(data.trend.previous[i]?.sales ?? 0) : undefined,
    }));
  }, [data]);

  const hourlyChartData: BarChartDatum[] = useMemo(
    () => (data ? data.hourly.hours.map((h) => ({ label: h.label, value: Number(h.sales), highlight: h.hour === data.hourly.peakSalesHour })) : []),
    [data]
  );
  const weekdayChartData: BarChartDatum[] = useMemo(
    () => (data ? data.weekdays.map((w) => ({ label: w.label.slice(0, 3), value: Number(w.totalSales) })) : []),
    [data]
  );
  const paymentDonutData: DonutDatum[] = useMemo(
    () => (data ? data.payments.methods.map((m) => ({ label: m.method === "CASH" ? "Gotovina" : "Kartica", value: Number(m.amount) })) : []),
    [data]
  );

  const currency = data?.kpi.current.currency ?? "RSD";
  const periodLabel = filters.preset === "custom" ? `${filters.from ?? "?"} — ${filters.to ?? "?"}` : filters.preset;
  const periodComparisonLabel = filters.preset === "today" ? "vs juče" : filters.preset === "yesterday" ? "vs prethodni dan" : "vs prethodni period";

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Kontrolna tabla"
        description="Stanje restorana upravo sada — promet, gotovina/kartica, kuhinja/bar, zalihe, storna i šta zahteva pažnju."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => load({ silent: true })}
              className="min-h-11 rounded-md border border-line px-3 py-2 text-sm font-semibold text-inkSoft hover:border-gold/50 hover:text-ink print:hidden"
              title="Osveži"
            >
              ↻ Osveži
            </button>
            <ReportFilters value={filters} onChange={setFilters} reportType="dashboard" />
          </div>
        }
      />

      <ReportPrintHeader title="Kontrolna tabla" periodLabel={periodLabel} />

      {error && <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      {loading || !data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          {/* ══════════════════════════════════════════════════════════════
              KONTROLNI CENTAR — uvek vidljivo, izvršni pregled (P2.3)
              ══════════════════════════════════════════════════════════════ */}

          {/* Level 1 — najvažniji brojevi */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard
              label="Promet"
              value={formatMoney(data.kpi.current.totalSales, currency)}
              accent
              changePercent={data.kpi.previousAvailable && data.kpi.previous ? pctChange(data.kpi.current.totalSales, data.kpi.previous.totalSales) : undefined}
              changeLabel={periodComparisonLabel}
            />
            <KpiCard
              label="Broj računa"
              value={String(data.kpi.current.completedOrders)}
              changePercent={data.kpi.previousAvailable && data.kpi.previous ? pctChange(data.kpi.current.completedOrders, data.kpi.previous.completedOrders) : undefined}
              changeLabel={periodComparisonLabel}
            />
            <KpiCard
              label="Prosečan račun"
              value={formatMoney(data.kpi.current.averageOrderValue, currency)}
              changePercent={data.kpi.previousAvailable && data.kpi.previous ? pctChange(data.kpi.current.averageOrderValue, data.kpi.previous.averageOrderValue) : undefined}
              changeLabel={periodComparisonLabel}
            />
            <KpiCard label="Neto prodaja" value={formatMoney(data.kpi.current.netSales, currency)} sub="posle poreza i popusta" />
          </section>
          {!data.kpi.previousAvailable && (
            <p className="mt-2 text-xs text-inkSoft">Poređenje sa prethodnim periodom nije dostupno (period prethodi otvaranju restorana).</p>
          )}
          {data.kpi.current.completedOrders === 0 && (
            <p className="mt-2 text-xs text-inkSoft">Još nema prodaje u izabranom periodu.</p>
          )}

          {/* Uvidi — lagan tekstualni rezime, ne nova tabela */}
          {data.insights.length > 0 && (
            <section className="mt-4">
              <Card className="p-4">
                <ul className="flex flex-wrap gap-x-6 gap-y-1.5">
                  {data.insights.map((insight, i) => (
                    <li key={i} className={`flex items-center gap-1.5 text-sm ${INSIGHT_COLOR[insight.tone]}`}>
                      <span className="font-bold">{INSIGHT_ICON[insight.tone]}</span>
                      <span className="text-ink">{insight.text}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {/* Level 2 — gotovina/kartica, kuhinja/bar, trend */}
          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Gotovina / Kartica</h2>
              <Card className="p-5">
                {paymentDonutData.length === 0 ? (
                  <EmptyState title="Nema plaćanja u periodu." compact />
                ) : (
                  <>
                    <PaymentDonutChart data={paymentDonutData} currency={currency} />
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div><p className="text-inkSoft">Gotovina</p><p className="font-semibold text-ink">{formatMoney(data.kpi.current.cashSales, currency)}</p></div>
                      <div><p className="text-inkSoft">Kartica</p><p className="font-semibold text-ink">{formatMoney(data.kpi.current.cardSales, currency)}</p></div>
                    </div>
                  </>
                )}
              </Card>
            </section>

            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Kuhinja naspram šanka</h2>
              <Card className="p-5">
                <StationBarChart
                  currency={currency}
                  data={[
                    { label: "Kuhinja", revenue: Number(data.stations.kitchen.revenue), voidValue: Number(data.stations.kitchen.voidValue) },
                    { label: "Šank", revenue: Number(data.stations.bar.revenue), voidValue: Number(data.stations.bar.voidValue) },
                  ]}
                />
                <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="font-medium text-ink">Kuhinja — {data.stations.kitchen.quantity} kom</p>
                    <p className="text-inkSoft">Storno: {data.stations.kitchen.voidQuantity} kom ({formatMoney(data.stations.kitchen.voidValue, currency)})</p>
                  </div>
                  <div>
                    <p className="font-medium text-ink">Šank — {data.stations.bar.quantity} kom</p>
                    <p className="text-inkSoft">Storno: {data.stations.bar.voidQuantity} kom ({formatMoney(data.stations.bar.voidValue, currency)})</p>
                  </div>
                </div>
              </Card>
            </section>
          </div>

          <section className="mt-8">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">
              Trend prodaje ({data.trend.granularity === "hour" ? "po satu" : data.trend.granularity === "day" ? "po danu" : "po mesecu"})
            </h2>
            <Card className="p-5">
              {trendChartData.length === 0 ? <EmptyState title="Nema prodaje u izabranom periodu." compact /> : <TrendLineChart data={trendChartData} currency={currency} />}
            </Card>
          </section>

          {/* Level 3 — top artikli, zalihe, storna, gotovina */}
          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-inkSoft">Top artikli</h2>
                <button
                  type="button"
                  onClick={() => setTopByQty((v) => !v)}
                  className="min-h-11 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-inkSoft hover:border-gold/50 hover:text-ink print:hidden"
                >
                  {topByQty ? "Po prometu" : "Po količini"}
                </button>
              </div>
              <Card className="overflow-hidden">
                {(topByQty ? data.items.topByQuantity : data.items.topItems).length === 0 ? (
                  <div className="p-5"><EmptyState title="Nema prodatih artikala." compact /></div>
                ) : (
                  <ul className="divide-y divide-line">
                    {(topByQty ? data.items.topByQuantity : data.items.topItems).slice(0, 5).map((r, i) => (
                      <li key={`${r.name}-${i}`} className="flex items-center justify-between px-4 py-2.5 text-sm">
                        <span className="text-ink">{r.name}</span>
                        <span className="text-right tabular-nums text-inkSoft">
                          {r.totalQuantity} kom · <span className="font-medium text-ink">{formatMoney(r.totalRevenue, currency)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Link href="/reports/items" className="mt-2 inline-block text-xs font-medium text-gold-dark hover:underline">Detalji →</Link>
            </section>

            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Zalihe</h2>
              <Card className="p-5">
                {data.stock.outOfStockCount === 0 && data.stock.lowStockCount === 0 ? (
                  <EmptyState title="Nema artikala sa niskom zalihom." compact />
                ) : (
                  <>
                    <div className="mb-3 grid grid-cols-2 gap-3 text-center">
                      <div>
                        <p className="text-lg font-bold text-danger">{data.stock.outOfStockCount}</p>
                        <p className="text-xs text-inkSoft">nema na zalihama</p>
                      </div>
                      <div>
                        <p className="text-lg font-bold text-warn">{data.stock.lowStockCount}</p>
                        <p className="text-xs text-inkSoft">niska zaliha</p>
                      </div>
                    </div>
                    <ul className="space-y-1.5 border-t border-line pt-3">
                      {data.stock.worstItems.map((it) => (
                        <li key={it.id} className="flex items-center justify-between text-xs">
                          <span className="text-ink">{it.name}</span>
                          <Badge tone={it.status === "out" ? "danger" : "warn"}>
                            {it.currentStock} {it.unit}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <Link href="/inventory" className="mt-3 inline-block text-xs font-medium text-gold-dark hover:underline">Idi na zalihe →</Link>
              </Card>
            </section>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Storna</h2>
              <Card className="p-5">
                {data.antifraud.voidCount === 0 ? (
                  <EmptyState title="Nema storniranih stavki u periodu." compact />
                ) : (
                  <p className="text-sm text-ink">
                    <span className="text-2xl font-bold">{data.antifraud.voidCount}</span> storna — <span className="font-semibold">{formatMoney(data.antifraud.voidValue, currency)}</span>
                  </p>
                )}
                <p className="mt-1 text-xs text-inkSoft">Storno nije uračunato u promet.</p>
                <Link href="/reports/anti-fraud" className="mt-3 inline-block text-xs font-medium text-gold-dark hover:underline">Detalji →</Link>
              </Card>
            </section>

            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Razlika u gotovini</h2>
              <Card className="p-5">
                {data.antifraud.cashDiscrepancyShiftsCount === 0 ? (
                  <EmptyState title="Nema razlike u gotovini u periodu." compact />
                ) : (
                  <p className="text-sm text-ink">
                    <span className="text-2xl font-bold">{data.antifraud.cashDiscrepancyShiftsCount}</span> {data.antifraud.cashDiscrepancyShiftsCount === 1 ? "smena" : "smena"} sa razlikom — ukupno <span className="font-semibold">{formatMoney(data.antifraud.cashDiscrepancyAbsTotal, currency)}</span>
                  </p>
                )}
                <Link href="/reports/anti-fraud" className="mt-3 inline-block text-xs font-medium text-gold-dark hover:underline">Detalji →</Link>
              </Card>
            </section>
          </div>

          {/* Level 4 — zahteva pažnju, aktivna smena / operativno stanje */}
          <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-inkSoft">Zahteva pažnju</h2>
                <Link href="/reports/anti-fraud" className="text-xs font-medium text-gold-dark hover:underline">Pogledaj sve →</Link>
              </div>
              <Card className="p-5">
                {!sortedSignals || sortedSignals.length === 0 ? (
                  <EmptyState title="Nema događaja koji zahtevaju pažnju." />
                ) : (
                  <ul className="space-y-3">
                    {sortedSignals.slice(0, 5).map((s, i) => (
                      <li key={i} className="border-b border-line pb-3 last:border-0 last:pb-0">
                        <div className="mb-1 flex items-center gap-2">
                          <Badge tone={SEVERITY_BADGE_TONE[s.severity]}>{SEVERITY_LABEL[s.severity]}</Badge>
                          <span className="text-sm font-medium text-ink">{signalCategoryLabel(s.category)}</span>
                        </div>
                        <p className="text-sm text-inkSoft">{s.description}</p>
                        {(s.employeeName || s.itemName) && (
                          <p className="mt-0.5 text-xs text-inkSoft">{s.employeeName ?? s.itemName} · {new Date(s.occurredAt).toLocaleString("sr-RS")}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </section>

            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Aktivna smena / stanje restorana</h2>
              <Card className="p-5">
                <div className="mb-4 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                  <div><p className="text-2xl font-bold text-ink">{data.status.openTables}</p><p className="text-xs text-inkSoft">Zauzeti stolovi</p></div>
                  <div><p className="text-2xl font-bold text-ink">{data.status.activeOrders}</p><p className="text-xs text-inkSoft">Aktivne porudžbine</p></div>
                  <div><p className="text-2xl font-bold text-ink">{data.status.kitchenPendingItems}</p><p className="text-xs text-inkSoft">Čeka kuhinju</p></div>
                  <div><p className="text-2xl font-bold text-ink">{data.status.barPendingItems}</p><p className="text-xs text-inkSoft">Čeka bar</p></div>
                </div>
                {data.status.shiftsOnDuty.length > 0 ? (
                  <div className="space-y-2 border-t border-line pt-3">
                    <p className="text-xs font-medium text-inkSoft">Otvorene smene</p>
                    {data.status.shiftsOnDuty.map((s) => (
                      <div key={s.shiftId} className="flex items-center justify-between text-sm">
                        <span className="text-ink">{s.employeeName} <span className="text-inkSoft">— {ROLE_LABEL[s.role] ?? s.role}</span></span>
                        <span className="text-xs text-inkSoft">
                          od {new Date(s.openedAt).toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" })} · otvarač {formatMoney(s.openingCash, currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="border-t border-line pt-3 text-sm text-inkSoft">Nema aktivne smene.</p>
                )}
                <Link href="/reports/shifts" className="mt-3 inline-block text-xs font-medium text-gold-dark hover:underline">Izveštaj smena →</Link>
              </Card>
            </section>
          </div>

          {/* ══════════════════════════════════════════════════════════════
              DETALJNA ANALITIKA — sklonjeno ispod (nije Reports duplikat,
              ostaje isti Faza 7 sadržaj, samo demovan iz glavnog pregleda
              da izvršni pregled ne bi imao 30 podjednako važnih kartica).
              ══════════════════════════════════════════════════════════════ */}
          <div className="mt-10 border-t border-line pt-6 print:hidden">
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="min-h-11 rounded-md border border-line px-4 py-2 text-sm font-semibold text-inkSoft hover:border-gold/50 hover:text-ink"
            >
              {showDetails ? "Sakrij detaljnu analitiku ↑" : "Prikaži detaljnu analitiku ↓"}
            </button>
          </div>

          {showDetails && (
            <div className="print:block">
              {/* ── Gužva po satu / danu u nedelji ──────────────────────── */}
              <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
                <section>
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Prodaja po satu</h2>
                  <Card className="p-5">
                    {hourlyChartData.every((h) => h.value === 0) ? (
                      <EmptyState title="Nema prodaje u izabranom periodu." compact />
                    ) : (
                      <>
                        <SalesBarChart data={hourlyChartData} currency={currency} />
                        <div className="mt-3 flex flex-wrap gap-4 text-xs text-inkSoft">
                          {data.hourly.peakSalesHour !== null && (
                            <span>Vrhunac prometa: <span className="font-semibold text-ink">{data.hourly.hours[data.hourly.peakSalesHour].label}</span></span>
                          )}
                          {data.hourly.peakOrderHour !== null && (
                            <span>Vrhunac broja porudžbina: <span className="font-semibold text-ink">{data.hourly.hours[data.hourly.peakOrderHour].label}</span></span>
                          )}
                        </div>
                      </>
                    )}
                  </Card>
                </section>
                <section>
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Prodaja po danu u nedelji</h2>
                  <Card className="p-5">
                    {weekdayChartData.every((w) => w.value === 0) ? (
                      <EmptyState title="Nema prodaje u izabranom periodu." compact />
                    ) : (
                      <>
                        <SalesBarChart data={weekdayChartData} currency={currency} />
                        <p className="mt-2 text-xs text-inkSoft">Prikazan je UKUPAN promet po danu; svaki dan se u periodu ponovio različit broj puta (vidi tabelu ispod za prosek po ponavljanju).</p>
                      </>
                    )}
                  </Card>
                </section>
              </div>

              {/* ── Top / najslabije prodavani artikli (puna tabela) ────── */}
              <section className="mt-8">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-inkSoft">Top proizvodi (detaljno)</h2>
                  <div className="no-print flex gap-1 rounded-md bg-ink/[0.04] p-1">
                    {([5, 10, 20] as ItemLimit[]).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setItemLimit(n)}
                        className={`min-h-11 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors ${itemLimit === n ? "bg-white text-ink shadow-sm" : "text-inkSoft hover:text-ink"}`}
                      >
                        Top {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                  <Card className="overflow-hidden">
                    <div className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-wide text-inkSoft">Top po prometu</div>
                    {data.items.topItems.length === 0 ? (
                      <div className="p-5"><EmptyState title="Nema prodatih artikala." compact /></div>
                    ) : (
                      <ItemTable rows={data.items.topItems} currency={currency} />
                    )}
                  </Card>
                  <Card className="overflow-hidden">
                    <div className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-wide text-inkSoft">Top po količini</div>
                    {data.items.topByQuantity.length === 0 ? (
                      <div className="p-5"><EmptyState title="Nema prodatih artikala." compact /></div>
                    ) : (
                      <ItemTable rows={data.items.topByQuantity} currency={currency} />
                    )}
                  </Card>
                  <Card className="overflow-hidden">
                    <div className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-wide text-inkSoft">Najslabije prodavani (od artikala koji jesu prodati)</div>
                    {data.items.lowItems.length === 0 ? (
                      <div className="p-5"><EmptyState title="Nema prodatih artikala." compact /></div>
                    ) : (
                      <ItemTable rows={data.items.lowItems} currency={currency} />
                    )}
                  </Card>
                </div>
                {data.items.zeroSaleItems.length > 0 && (
                  <div className="mt-4">
                    <p className="mb-2 text-xs text-inkSoft">
                      Artikli sa trenutnog menija bez zabeležene prodaje u periodu — zasnovano na TRENUTNOM meniju, ne na istorijskim podacima (artikal preimenovan posle prodaje može se pogrešno pojaviti ovde).
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {data.items.zeroSaleItems.slice(0, 24).map((z) => (
                        <Badge key={z.id} tone="neutral">{z.name}</Badge>
                      ))}
                      {data.items.zeroSaleItems.length > 24 && (
                        <Badge tone="neutral">+{data.items.zeroSaleItems.length - 24} još</Badge>
                      )}
                    </div>
                  </div>
                )}
              </section>

              {/* ── Performanse po kategoriji ────────────────────────────── */}
              <section className="mt-8">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Performanse po kategoriji</h2>
                <p className="mb-2 text-xs text-inkSoft">Naziv kategorije je TRENUTAN (iz aktivnog menija), ne istorijski snapshot — preimenovanje kategorije menja prikaz i za stare periode.</p>
                <Card className="overflow-hidden">
                  {data.categories.categories.length === 0 ? (
                    <div className="p-5"><EmptyState title="Nema prodaje u izabranom periodu." compact /></div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                            <th className="px-4 py-3 font-medium">Kategorija</th>
                            <th className="px-4 py-3 text-right font-medium">Količina</th>
                            <th className="px-4 py-3 text-right font-medium">Promet</th>
                            <th className="px-4 py-3 text-right font-medium">% prometa</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.categories.categories.map((c) => (
                            <tr key={c.categoryName} className="border-b border-line last:border-0">
                              <td className="px-4 py-3 text-ink">{c.categoryName}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{c.quantity}</td>
                              <td className="px-4 py-3 text-right tabular-nums font-medium text-ink">{formatMoney(c.revenue, currency)}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{c.percentOfTotal}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              </section>

              {/* ── Zaposleni ─────────────────────────────────────────────── */}
              <section className="mt-8">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-inkSoft">Prodaja po zaposlenom</h2>
                  <div className="no-print flex gap-1 rounded-md bg-ink/[0.04] p-1">
                    {([["sales", "Prodaja"], ["orders", "Porudžbine"], ["avgOrder", "Prosek"]] as [EmployeeSortKey, string][]).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setEmployeeSort(key)}
                        className={`min-h-11 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors ${employeeSort === key ? "bg-white text-ink shadow-sm" : "text-inkSoft hover:text-ink"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="mb-2 text-xs text-inkSoft">Ovo je rangiranje po prodaji, ne ocena rada — prodaja zavisi od trajanja smene, sekcije i gužve.</p>
                <Card className="overflow-hidden">
                  {sortedEmployees.length === 0 ? (
                    <div className="p-5"><EmptyState title="Nema aktivnosti u izabranom periodu." compact /></div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                            <th className="px-4 py-3 font-medium">Zaposleni</th>
                            <th className="px-4 py-3 text-right font-medium">Porudžbine</th>
                            <th className="px-4 py-3 text-right font-medium">Prodaja</th>
                            <th className="px-4 py-3 text-right font-medium">Prosek</th>
                            <th className="px-4 py-3 text-right font-medium">Storna</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedEmployees.map((e) => (
                            <tr key={e.employeeId} className="border-b border-line last:border-0">
                              <td className="px-4 py-3 text-ink">{e.employeeName} <span className="text-xs text-inkSoft">— {ROLE_LABEL[e.role] ?? e.role}</span></td>
                              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{e.completedOrders}</td>
                              <td className="px-4 py-3 text-right tabular-nums font-medium text-ink">{formatMoney(e.sales, currency)}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{formatMoney(e.averageOrderValue, currency)}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{e.voidCount > 0 ? formatMoney(e.voidValue, currency) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>

                <div className="mt-4">
                  <p className="mb-2 text-xs text-inkSoft">{data.employeesNormalized.approximationNote}</p>
                  <Card className="overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                            <th className="px-4 py-3 font-medium">Zaposleni</th>
                            <th className="px-4 py-3 text-right font-medium">Prodaja/sat</th>
                            <th className="px-4 py-3 text-right font-medium">Porudžbine/sat</th>
                            <th className="px-4 py-3 text-right font-medium">Storno %</th>
                            <th className="px-4 py-3 text-right font-medium">Popust %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.employeesNormalized.rows.map((e) => (
                            <tr key={e.employeeId} className="border-b border-line last:border-0">
                              <td className="px-4 py-3 text-ink">{e.employeeName}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{e.salesPerHour ? formatMoney(e.salesPerHour, currency) : "—"}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{e.ordersPerHour ?? "—"}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{e.voidPercent !== null ? `${e.voidPercent}%` : "—"}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{e.discountPercent !== null ? `${e.discountPercent}%` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </div>
              </section>

              {/* ── Storna (detaljno) / Popusti ─────────────────────────── */}
              <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
                <section>
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Storna — detaljno</h2>
                  <Card className="p-5">
                    <div className="mb-3 grid grid-cols-3 gap-2 text-center">
                      <div><p className="text-lg font-bold text-ink">{formatMoney(data.voids.totalVoidValue, currency)}</p><p className="text-xs text-inkSoft">Vrednost</p></div>
                      <div><p className="text-lg font-bold text-ink">{data.voids.voidCount}</p><p className="text-xs text-inkSoft">Broj</p></div>
                      <div><p className="text-lg font-bold text-ink">{data.voids.voidPercentOfSales !== null ? `${data.voids.voidPercentOfSales}%` : "—"}</p><p className="text-xs text-inkSoft">% prodaje</p></div>
                    </div>
                    {data.voids.trendVsPreviousPercent !== null && (
                      <p className="mb-3 text-xs text-inkSoft">Trend: {data.voids.trendVsPreviousPercent >= 0 ? "+" : ""}{data.voids.trendVsPreviousPercent}% vs prethodni period</p>
                    )}
                    {data.voids.anomalies.length > 0 && (
                      <div className="mb-3 space-y-2 border-t border-line pt-3">
                        <p className="text-xs font-medium text-inkSoft">Preporučuje se pregled</p>
                        {data.voids.anomalies.slice(0, 4).map((a, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs">
                            <Badge tone={SEVERITY_BADGE_TONE[a.severity]}>{SEVERITY_LABEL[a.severity]}</Badge>
                            <span className="text-inkSoft">{a.description}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="space-y-1 border-t border-line pt-3">
                      {data.voids.byReason.slice(0, 5).map((r) => (
                        <div key={r.reasonCode} className="flex justify-between text-xs">
                          <span className="text-inkSoft">{r.reasonLabel}</span>
                          <span className="font-medium text-ink">{r.count}× — {formatMoney(r.value, currency)}</span>
                        </div>
                      ))}
                    </div>
                    <Link href="/reports/voids" className="mt-3 inline-block text-xs font-medium text-gold-dark hover:underline">Detaljan izveštaj poništavanja →</Link>
                  </Card>
                </section>

                <section>
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Popusti</h2>
                  <Card className="p-5">
                    <div className="mb-3 grid grid-cols-2 gap-2 text-center">
                      <div><p className="text-lg font-bold text-ink">{formatMoney(data.discounts.totalDiscountValue, currency)}</p><p className="text-xs text-inkSoft">Ukupno</p></div>
                      <div><p className="text-lg font-bold text-ink">{data.discounts.discountPercentOfGross !== null ? `${data.discounts.discountPercentOfGross}%` : "—"}</p><p className="text-xs text-inkSoft">% bruto prodaje</p></div>
                    </div>
                    <div className="space-y-1 border-t border-line pt-3">
                      {data.discounts.byEmployee.slice(0, 5).map((e) => (
                        <div key={e.employeeId} className="flex justify-between text-xs">
                          <span className="text-inkSoft">{e.employeeName}</span>
                          <span className="font-medium text-ink">{e.orderCount}× — {formatMoney(e.discountTotal, currency)}</span>
                        </div>
                      ))}
                      {data.discounts.byEmployee.length === 0 && <p className="text-xs text-inkSoft">Nema popusta u periodu.</p>}
                    </div>
                  </Card>
                </section>
              </div>

              {/* ── Smene (detaljno) ─────────────────────────────────────── */}
              <div className="mt-8">
                <section>
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Smene — detaljno</h2>
                  <Card className="p-5">
                    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                      <div><p className="text-inkSoft">Broj smena</p><p className="font-medium text-ink">{data.shifts.shiftCount}</p></div>
                      <div><p className="text-inkSoft">Prosek po smeni</p><p className="font-medium text-ink">{formatMoney(data.shifts.averageSalesPerShift, currency)}</p></div>
                      <div><p className="text-inkSoft">Očekivana gotovina</p><p className="font-medium text-ink">{formatMoney(data.shifts.totalCashExpected, currency)}</p></div>
                      <div><p className="text-inkSoft">Prebrojana gotovina</p><p className="font-medium text-ink">{formatMoney(data.shifts.totalCashCounted, currency)}</p></div>
                    </div>
                    {(data.shifts.largestPositiveVariance || data.shifts.largestNegativeVariance) && (
                      <div className="mt-3 space-y-1 border-t border-line pt-3 text-xs">
                        {data.shifts.largestPositiveVariance && (
                          <p className="text-success">Najveći višak: {formatMoney(data.shifts.largestPositiveVariance.value, currency)} ({data.shifts.largestPositiveVariance.employeeName})</p>
                        )}
                        {data.shifts.largestNegativeVariance && (
                          <p className="text-danger">Najveći manjak: {formatMoney(data.shifts.largestNegativeVariance.value, currency)} ({data.shifts.largestNegativeVariance.employeeName})</p>
                        )}
                      </div>
                    )}
                    <Link href="/reports/shifts" className="mt-3 inline-block text-xs font-medium text-gold-dark hover:underline">Detaljan izveštaj smena →</Link>
                  </Card>
                </section>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function pctChange(current: number | string, previous: number | string): number | null {
  const c = Number(current);
  const p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return Math.round(((c - p) / p) * 1000) / 10;
}

function ItemTable({ rows, currency }: { rows: RankedItem[]; currency: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
            <th className="px-4 py-3 font-medium">Artikal</th>
            <th className="px-4 py-3 font-medium">Kategorija</th>
            <th className="px-4 py-3 text-right font-medium">Količina</th>
            <th className="px-4 py-3 text-right font-medium">Promet</th>
            <th className="px-4 py-3 text-right font-medium">%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.name}-${i}`} className="border-b border-line last:border-0">
              <td className="px-4 py-3 font-medium text-ink">{r.name}</td>
              <td className="px-4 py-3 text-inkSoft">{r.categoryName ?? "—"}</td>
              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{r.totalQuantity}</td>
              <td className="px-4 py-3 text-right tabular-nums font-medium text-ink">{formatMoney(r.totalRevenue, currency)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{r.percentOfTotal}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
