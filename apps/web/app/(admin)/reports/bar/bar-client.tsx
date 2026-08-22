"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { KpiCard } from "../../../../components/admin/KpiCard";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../../components/admin/ReportFilters";
import { ReportPrintHeader } from "../../../../components/admin/ReportPrintHeader";

interface BarProductionRow {
  name: string;
  producedQty: number;
  voidedQty: number;
}

interface BarProductionReport {
  range: { from: string; to: string };
  rows: BarProductionRow[];
  summary: {
    totalProduced: number;
    totalVoided: number;
    uniqueItems: number;
  };
}

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function downloadCsv(rows: BarProductionRow[]) {
  const header = "Artikal,Izbačeno,Stornirano";
  const lines = rows.map(
    (r) => `"${r.name.replace(/"/g, '""')}",${r.producedQty},${r.voidedQty}`
  );
  const csv = [header, ...lines].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "bar-produkcija.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function BarProductionClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [report, setReport] = useState<BarProductionReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = reportFiltersToQuery(filters);
    try {
      const data = await apiFetch(`/api/admin/reports/production/bar?${query}`);
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju izveštaja");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = report?.rows ?? [];
  const summary = report?.summary;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Bar produkcija</h1>
          <p className="mt-1 text-sm text-inkSoft">
            Stavke koje je šank izbacio (SERVED) i poništene stavke bar stanice
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-11 rounded-md border border-line px-3 py-2 text-sm font-semibold text-inkSoft hover:border-gold/50 hover:text-ink print:hidden"
          >
            Štampaj / PDF
          </button>
          <ReportFilters value={filters} onChange={setFilters} />
        </div>
      </div>

      <ReportPrintHeader
        title="Bar produkcija"
        periodLabel={filters.preset === "custom" ? `${filters.from ?? "?"} — ${filters.to ?? "?"}` : filters.preset}
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {loading || !summary ? (
        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : (
        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KpiCard label="Ukupno izbačeno" value={String(summary.totalProduced)} accent sub="komada" />
          <KpiCard label="Stornirano" value={String(summary.totalVoided)} sub="komada" />
          <KpiCard label="Jedinstvenih artikala" value={String(summary.uniqueItems)} />
        </div>
      )}

      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-inkSoft uppercase tracking-wide">Pregled po artiklima</h2>
        {rows.length > 0 && (
          <button
            onClick={() => downloadCsv(rows)}
            className="flex min-h-11 items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-inkSoft hover:bg-ink/[0.04] print:hidden"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            Izvezi CSV
          </button>
        )}
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-5"><Skeleton className="h-48" /></div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <EmptyState title="Nema bar produkcije u izabranom periodu." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                  <th className="px-4 py-3 font-medium">Artikal</th>
                  <th className="px-4 py-3 text-right font-medium">Izbačeno</th>
                  <th className="px-4 py-3 text-right font-medium">Stornirano</th>
                  <th className="px-4 py-3 text-right font-medium text-inkSoft/60">Vraćeno</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name} className="border-b border-line last:border-0 hover:bg-ink/[0.02]">
                    <td className="px-4 py-3 font-medium text-ink">{row.name}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink">{row.producedQty}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.voidedQty > 0 ? (
                        <span className="font-medium text-danger">{row.voidedQty}</span>
                      ) : (
                        <span className="text-inkSoft">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-inkSoft/50 italic text-xs">
                      nije evidentirano
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line bg-ink/[0.02]">
                  <td className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-inkSoft">Ukupno</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-ink">
                    {rows.reduce((s, r) => s + r.producedQty, 0)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-danger">
                    {rows.reduce((s, r) => s + r.voidedQty, 0) || "—"}
                  </td>
                  <td className="px-4 py-3" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-3 text-xs text-inkSoft">
        Izbačeno = stavke koje su prošle kroz bar KDS ekran i dostigle status{" "}
        <span className="font-medium">SERVED</span> tokom izabranog perioda (po vremenu završetka
        na šanku). Stornirano = poništene stavke bar stanice. Vraćeno nije evidentirano u
        trenutnoj verziji sistema.
      </p>
    </div>
  );
}
