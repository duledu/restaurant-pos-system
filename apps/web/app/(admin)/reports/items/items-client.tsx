"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@rcs/shared";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { KpiCard } from "../../../../components/admin/KpiCard";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../../components/admin/ReportFilters";

type StationFilter = "ALL" | "KITCHEN" | "BAR";
type SortField = "revenue" | "quantity" | "name";

interface SoldItemRow {
  name: string;
  station: string;
  categoryName: string | null;
  totalQuantity: number;
  totalRevenue: string;
  avgPrice: string;
}

interface SoldItemsSummary {
  allQuantity: number;
  allRevenue: string;
  kitchenQuantity: number;
  kitchenRevenue: string;
  barQuantity: number;
  barRevenue: string;
}

interface SoldItemsReport {
  currency: string;
  station: StationFilter;
  rows: SoldItemRow[];
  summary: SoldItemsSummary;
}

const STATION_TABS: { value: StationFilter; label: string }[] = [
  { value: "ALL", label: "Sve" },
  { value: "KITCHEN", label: "Kuhinja" },
  { value: "BAR", label: "Šank" },
];

const STATION_LABEL: Record<string, string> = {
  KITCHEN: "Kuhinja",
  BAR: "Šank",
  KITCHEN_AND_BAR: "Kuhinja + Šank",
  NONE: "—",
};

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function sortRows(rows: SoldItemRow[], field: SortField): SoldItemRow[] {
  return [...rows].sort((a, b) => {
    if (field === "name") return a.name.localeCompare(b.name, "sr");
    if (field === "quantity") return b.totalQuantity - a.totalQuantity;
    return Number(b.totalRevenue) - Number(a.totalRevenue);
  });
}

function SortButton({
  field,
  active,
  onClick,
  children,
}: {
  field: SortField;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 font-medium transition-colors ${active ? "text-gold" : "hover:text-ink"}`}
    >
      {children}
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className={active ? "text-gold" : "text-inkSoft/60"}
      >
        <path d="M7 10l5-6 5 6M7 14l5 6 5-6" />
      </svg>
    </button>
  );
}

export function ItemsClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [station, setStation] = useState<StationFilter>("ALL");
  const [report, setReport] = useState<SoldItemsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("revenue");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = reportFiltersToQuery(filters);
    try {
      const data = await apiFetch(`/api/admin/reports/items?${query}&station=${station}`);
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju izveštaja");
    } finally {
      setLoading(false);
    }
  }, [filters, station]);

  useEffect(() => {
    load();
  }, [load]);

  const currency = report?.currency ?? "RSD";
  const summary = report?.summary;
  const rows = report ? sortRows(report.rows, sortField) : [];

  function toggleSort(field: SortField) {
    setSortField(field);
  }

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header + filters */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Prodati artikli</h1>
          <p className="mt-1 text-sm text-inkSoft">
            Promet po artiklima — šta je prodato, koliko komada i koliko je zaradila svaka stanica
          </p>
        </div>
        <ReportFilters value={filters} onChange={setFilters} />
      </div>

      {error && (
        <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* Station tabs */}
      <div className="mb-6 flex gap-1 rounded-lg bg-ink/[0.04] p-1 w-fit">
        {STATION_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStation(tab.value)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              station === tab.value
                ? "bg-white text-ink shadow-sm"
                : "text-inkSoft hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* KPI cards */}
      {loading || !summary ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-8">
          {[...Array(station === "ALL" ? 4 : 2)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-8">
          {station === "ALL" && (
            <>
              <KpiCard
                label="Ukupno stavki"
                value={String(summary.allQuantity)}
                accent
              />
              <KpiCard
                label="Ukupan promet"
                value={formatMoney(summary.allRevenue, currency)}
                accent
              />
              <KpiCard
                label="Kuhinja promet"
                value={formatMoney(summary.kitchenRevenue, currency)}
                sub={`${summary.kitchenQuantity} kom`}
              />
              <KpiCard
                label="Šank promet"
                value={formatMoney(summary.barRevenue, currency)}
                sub={`${summary.barQuantity} kom`}
              />
            </>
          )}
          {station === "KITCHEN" && (
            <>
              <KpiCard
                label="Kuhinjskih stavki"
                value={String(summary.kitchenQuantity)}
                accent
              />
              <KpiCard
                label="Promet kuhinje"
                value={formatMoney(summary.kitchenRevenue, currency)}
                accent
              />
            </>
          )}
          {station === "BAR" && (
            <>
              <KpiCard
                label="Stavki sa šanka"
                value={String(summary.barQuantity)}
                accent
              />
              <KpiCard
                label="Promet šanka"
                value={formatMoney(summary.barRevenue, currency)}
                accent
              />
            </>
          )}
        </div>
      )}

      {/* Detailed table */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-5">
            <Skeleton className="h-48" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5">
            <EmptyState title="Nema prodatih artikala u izabranom periodu." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                  <th className="px-4 py-3 font-medium">
                    <SortButton field="name" active={sortField === "name"} onClick={() => toggleSort("name")}>
                      Artikal
                    </SortButton>
                  </th>
                  <th className="px-4 py-3 font-medium">Kategorija</th>
                  {station === "ALL" && <th className="px-4 py-3 font-medium">Stanica</th>}
                  <th className="px-4 py-3 text-right font-medium">
                    <SortButton field="quantity" active={sortField === "quantity"} onClick={() => toggleSort("quantity")}>
                      Količina
                    </SortButton>
                  </th>
                  <th className="px-4 py-3 text-right font-medium">Pros. cena</th>
                  <th className="px-4 py-3 text-right font-medium">
                    <SortButton field="revenue" active={sortField === "revenue"} onClick={() => toggleSort("revenue")}>
                      Promet
                    </SortButton>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={`${row.name}::${row.station}::${i}`} className="border-b border-line last:border-0 hover:bg-ink/[0.02]">
                    <td className="px-4 py-3 font-medium text-ink">{row.name}</td>
                    <td className="px-4 py-3 text-inkSoft">{row.categoryName ?? "—"}</td>
                    {station === "ALL" && (
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                            row.station === "KITCHEN" || row.station === "KITCHEN_AND_BAR"
                              ? "bg-amber-100 text-amber-800"
                              : row.station === "BAR"
                              ? "bg-blue-100 text-blue-800"
                              : "bg-ink/[0.06] text-inkSoft"
                          }`}
                        >
                          {STATION_LABEL[row.station] ?? row.station}
                        </span>
                      </td>
                    )}
                    <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{row.totalQuantity}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{formatMoney(row.avgPrice, currency)}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-ink">{formatMoney(row.totalRevenue, currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line bg-ink/[0.02]">
                  <td colSpan={station === "ALL" ? 3 : 2} className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-inkSoft">
                    Ukupno
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-ink">
                    {rows.reduce((s, r) => s + r.totalQuantity, 0)}
                  </td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-ink">
                    {formatMoney(
                      rows.reduce((s, r) => s + Number(r.totalRevenue), 0).toString(),
                      currency
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-3 text-xs text-inkSoft">
        Prikazano: {rows.length} artikala. Artikli sa stanicom{" "}
        <span className="font-medium">Kuhinja + Šank</span> su finansijski pripisani Kuhinji
        — zbir Kuhinja + Šank = Ukupan promet (bez dupliranja).
      </p>
    </div>
  );
}
