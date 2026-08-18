"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@rcs/shared";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../../components/admin/ReportFilters";
import { ReportPrintHeader } from "../../../../components/admin/ReportPrintHeader";

interface VoidRow {
  id: string;
  employeeName: string;
  role: string;
  tableLabel: string;
  itemName: string;
  voidedQuantity: number;
  voidedValue: string;
  reasonLabel: string;
  explanation: string;
  voidedAt: string;
}
interface SummaryRow {
  employeeId: string;
  employeeName: string;
  role: string;
  voidCount: number;
  voidValue: string;
}

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function VoidsClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [rows, setRows] = useState<VoidRow[] | null>(null);
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = reportFiltersToQuery(filters);
    try {
      const [voidsRes, summaryRes] = await Promise.all([
        apiFetch(`/api/admin/reports/voids?${query}`),
        apiFetch(`/api/admin/reports/voids/summary?${query}`),
      ]);
      setRows(voidsRes.rows);
      setSummary(summaryRes.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju poništavanja");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const visibleRows = selectedEmployee ? (rows ?? []).filter((r) => r.employeeName === selectedEmployee) : rows;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Poništavanja poslatih stavki</h1>
          <p className="mt-1 text-sm text-inkSoft">Dokazi za pregled — ne optužba. Ovo su ispravke već poslatih stavki.</p>
        </div>
        <ReportFilters value={filters} onChange={setFilters} reportType="voids" />
      </div>

      <ReportPrintHeader
        title="Poništavanja poslatih stavki"
        periodLabel={filters.preset === "custom" ? `${filters.from ?? "?"} — ${filters.to ?? "?"}` : filters.preset}
      />

      {error && <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Aktivnost poništavanja po zaposlenom</h2>
        <Card className="overflow-hidden">
          {loading || !summary ? (
            <div className="p-5">
              <Skeleton className="h-24" />
            </div>
          ) : summary.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Nema poništenih stavki u izabranom periodu." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                    <th className="px-4 py-3 font-medium">Zaposleni</th>
                    <th className="px-4 py-3 font-medium">Poništavanja</th>
                    <th className="px-4 py-3 text-right font-medium">Vrednost</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((row) => (
                    <tr
                      key={row.employeeId}
                      onClick={() => setSelectedEmployee(selectedEmployee === row.employeeName ? null : row.employeeName)}
                      className={`cursor-pointer border-b border-line last:border-0 hover:bg-ink/[0.02] ${
                        selectedEmployee === row.employeeName ? "bg-gold/[0.06]" : ""
                      }`}
                    >
                      <td className="px-4 py-3 text-ink">{row.employeeName}</td>
                      <td className="px-4 py-3 text-inkSoft">{row.voidCount}</td>
                      <td className="px-4 py-3 text-right font-medium text-ink">{formatMoney(row.voidValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-inkSoft">
            Pojedinačna poništavanja {selectedEmployee && `— ${selectedEmployee}`}
          </h2>
          {selectedEmployee && (
            <button onClick={() => setSelectedEmployee(null)} className="text-xs font-medium text-gold-dark">
              Prikaži sve
            </button>
          )}
        </div>
        {loading || !visibleRows ? (
          <Skeleton className="h-40" />
        ) : visibleRows.length === 0 ? (
          <Card className="p-5">
            <EmptyState title="Nema poništenih stavki u izabranom periodu." />
          </Card>
        ) : (
          <div className="space-y-2">
            {visibleRows.map((v) => (
              <Card key={v.id} className="p-4">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-medium text-ink">{v.employeeName}</span>
                    <span className="text-inkSoft"> · {v.tableLabel}</span>
                  </div>
                  <span className="text-xs text-inkSoft">{new Date(v.voidedAt).toLocaleString("sr-RS")}</span>
                </div>
                <p className="text-sm text-ink">
                  {v.voidedQuantity}× {v.itemName} <span className="font-medium">— {formatMoney(v.voidedValue)}</span>
                </p>
                <p className="mt-1 text-xs text-inkSoft">
                  Razlog: <span className="font-medium">{v.reasonLabel}</span>
                </p>
                <p className="mt-0.5 text-xs italic text-inkSoft">„{v.explanation}“</p>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
