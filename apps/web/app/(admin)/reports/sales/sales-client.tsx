"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@rcs/shared";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { KpiCard } from "../../../../components/admin/KpiCard";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../../components/admin/ReportFilters";
import { ReportPrintHeader } from "../../../../components/admin/ReportPrintHeader";

interface SalesSummary {
  currency: string;
  totalSales: string;
  cashSales: string;
  cardSales: string;
  completedOrders: number;
  averageOrderValue: string;
  cashPercent: number;
  cardPercent: number;
  grossSales: string;
  netSales: string;
  discountTotal: string;
  taxTotal: string;
  voidTotal: string;
}
interface EmployeeSales {
  employeeId: string;
  employeeName: string;
  role: string;
  orders: number;
  sales: string;
}

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function SalesClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [byEmployee, setByEmployee] = useState<EmployeeSales[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = reportFiltersToQuery(filters);
    try {
      const [summaryRes, employeeRes] = await Promise.all([
        apiFetch(`/api/admin/reports/sales?${query}`),
        apiFetch(`/api/admin/reports/sales/by-employee?${query}`),
      ]);
      setSummary(summaryRes);
      setByEmployee(employeeRes.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju izveštaja");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Izveštaj o prodaji</h1>
          <p className="mt-1 text-sm text-inkSoft">Ukupna prodaja, gotovina/kartica i prodaja po zaposlenom</p>
        </div>
        <ReportFilters value={filters} onChange={setFilters} reportType="sales" />
      </div>

      {summary && (
        <ReportPrintHeader
          title="Izveštaj o prodaji"
          periodLabel={filters.preset === "custom" ? `${filters.from ?? "?"} — ${filters.to ?? "?"}` : filters.preset}
        />
      )}

      {error && <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      {loading || !summary ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <KpiCard label="Ukupna prodaja (neto)" value={formatMoney(summary.netSales, summary.currency)} accent />
            <KpiCard label="Gotovina" value={formatMoney(summary.cashSales, summary.currency)} sub={`${summary.cashPercent}%`} />
            <KpiCard label="Kartica" value={formatMoney(summary.cardSales, summary.currency)} sub={`${summary.cardPercent}%`} />
            <KpiCard label="Porudžbine" value={String(summary.completedOrders)} />
            <KpiCard label="Prosečna porudžbina" value={formatMoney(summary.averageOrderValue, summary.currency)} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard label="Bruto prodaja" value={formatMoney(summary.grossSales, summary.currency)} />
            <KpiCard label="Popusti" value={formatMoney(summary.discountTotal, summary.currency)} />
            <KpiCard label="PDV" value={formatMoney(summary.taxTotal, summary.currency)} />
            <KpiCard label="Storna" value={formatMoney(summary.voidTotal, summary.currency)} />
          </div>
        </>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Prodaja po zaposlenom</h2>
        <Card className="overflow-hidden">
          {loading || !byEmployee ? (
            <div className="p-5">
              <Skeleton className="h-32" />
            </div>
          ) : byEmployee.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Nema prodaje u izabranom periodu." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                    <th className="px-4 py-3 font-medium">Zaposleni</th>
                    <th className="px-4 py-3 font-medium">Porudžbine</th>
                    <th className="px-4 py-3 text-right font-medium">Prodaja</th>
                  </tr>
                </thead>
                <tbody>
                  {byEmployee.map((row) => (
                    <tr key={row.employeeId} className="border-b border-line last:border-0">
                      <td className="px-4 py-3 text-ink">{row.employeeName}</td>
                      <td className="px-4 py-3 text-inkSoft">{row.orders}</td>
                      <td className="px-4 py-3 text-right font-medium text-ink">{formatMoney(row.sales, summary?.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
