"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatMoney } from "@rcs/shared";
import { Card } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import { KpiCard } from "../../../components/admin/KpiCard";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../components/admin/ReportFilters";
import { SEVERITY_BADGE_TONE, SEVERITY_LABEL, signalCategoryLabel, type Severity } from "../../../components/admin/severity";
import { ROLE_LABEL } from "../../../components/admin/role-labels";

interface SalesSummary {
  currency: string;
  totalSales: string;
  cashSales: string;
  cardSales: string;
  completedOrders: number;
  averageOrderValue: string;
  cashPercent: number;
  cardPercent: number;
}
interface CurrentStatus {
  openTables: number;
  activeOrders: number;
  openShiftsCount: number;
  shiftsOnDuty: { shiftId: string; employeeName: string; role: string; openedAt: string }[];
}
interface SuspiciousSignal {
  category: string;
  severity: Severity;
  employeeId: string;
  employeeName: string;
  description: string;
  occurredAt: string;
  count?: number;
  value?: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { HIGH: 0, WARNING: 1, INFO: 2 };

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function DashboardClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [sales, setSales] = useState<SalesSummary | null>(null);
  const [status, setStatus] = useState<CurrentStatus | null>(null);
  const [signals, setSignals] = useState<SuspiciousSignal[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = reportFiltersToQuery(filters);
    try {
      const [salesRes, statusRes, attentionRes] = await Promise.all([
        apiFetch(`/api/admin/reports/sales?${query}`),
        apiFetch(`/api/admin/reports/status?locationId=${filters.locationId}`),
        apiFetch(`/api/admin/reports/attention?locationId=${filters.locationId}`),
      ]);
      setSales(salesRes);
      setStatus(statusRes);
      setSignals(attentionRes.signals);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju pregleda");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const sortedSignals = useMemo(
    () =>
      signals
        ? [...signals].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
        : null,
    [signals]
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Pregled poslovanja</h1>
          <p className="mt-1 text-sm text-inkSoft">Trenutno stanje restorana i poslovni rezultat</p>
        </div>
        <ReportFilters value={filters} onChange={setFilters} />
      </div>

      {error && <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      {/* ── Prodaja ─────────────────────────────────────────────────── */}
      <section className="mb-8">
        {loading || !sales ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <KpiCard label="Prodaja" value={formatMoney(sales.totalSales, sales.currency)} accent />
              <KpiCard label="Gotovina" value={formatMoney(sales.cashSales, sales.currency)} sub={`${sales.cashPercent}%`} />
              <KpiCard label="Kartica" value={formatMoney(sales.cardSales, sales.currency)} sub={`${sales.cardPercent}%`} />
              <KpiCard label="Porudžbine" value={String(sales.completedOrders)} />
              <KpiCard label="Prosečna porudžbina" value={formatMoney(sales.averageOrderValue, sales.currency)} />
            </div>

            {Number(sales.totalSales) > 0 && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-ink/[0.06]">
                <div className="flex h-full">
                  <div className="h-full bg-gold" style={{ width: `${sales.cashPercent}%` }} />
                  <div className="h-full bg-info" style={{ width: `${sales.cardPercent}%` }} />
                </div>
              </div>
            )}
            {Number(sales.totalSales) === 0 && (
              <p className="mt-3 text-sm text-inkSoft">Nema evidentiranih prodaja u izabranom periodu.</p>
            )}
          </>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ── Restoran sada ─────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Restoran sada</h2>
          <Card className="p-5">
            {loading || !status ? (
              <Skeleton className="h-32" />
            ) : (
              <>
                <div className="mb-4 grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-2xl font-bold text-ink">{status.openTables}</p>
                    <p className="text-xs text-inkSoft">Zauzeti stolovi</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-ink">{status.activeOrders}</p>
                    <p className="text-xs text-inkSoft">Aktivne porudžbine</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-ink">{status.openShiftsCount}</p>
                    <p className="text-xs text-inkSoft">Otvorene smene</p>
                  </div>
                </div>
                {status.shiftsOnDuty.length > 0 ? (
                  <div className="space-y-2 border-t border-line pt-3">
                    <p className="text-xs font-medium text-inkSoft">Smenu otvorili</p>
                    {status.shiftsOnDuty.map((s) => (
                      <div key={s.shiftId} className="flex items-center justify-between text-sm">
                        <span className="text-ink">
                          {s.employeeName} <span className="text-inkSoft">— {ROLE_LABEL[s.role] ?? s.role}</span>
                        </span>
                        <span className="text-xs text-inkSoft">
                          od {new Date(s.openedAt).toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="border-t border-line pt-3 text-sm text-inkSoft">Nema trenutno otvorenih smena.</p>
                )}
              </>
            )}
          </Card>
        </section>

        {/* ── Zahteva pažnju ────────────────────────────────────────── */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-inkSoft">Zahteva pažnju</h2>
            <Link href="/activity" className="text-xs font-medium text-gold-dark hover:underline">
              Sva aktivnost →
            </Link>
          </div>
          <Card className="p-5">
            {loading || !sortedSignals ? (
              <Skeleton className="h-32" />
            ) : sortedSignals.length === 0 ? (
              <EmptyState title="Trenutno nema stavki koje zahtevaju pažnju." />
            ) : (
              <ul className="space-y-3">
                {sortedSignals.slice(0, 6).map((s, i) => (
                  <li key={i} className="border-b border-line pb-3 last:border-0 last:pb-0">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge tone={SEVERITY_BADGE_TONE[s.severity]}>{SEVERITY_LABEL[s.severity]}</Badge>
                      <span className="text-sm font-medium text-ink">{signalCategoryLabel(s.category)}</span>
                    </div>
                    <p className="text-sm text-inkSoft">{s.description}</p>
                    <p className="mt-0.5 text-xs text-inkSoft">
                      {s.employeeName} · {new Date(s.occurredAt).toLocaleString("sr-RS")}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}
