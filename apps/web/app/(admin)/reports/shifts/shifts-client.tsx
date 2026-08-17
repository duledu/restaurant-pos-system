"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@rcs/shared";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../../components/admin/ReportFilters";

interface ShiftRow {
  id: string;
  status: "OPEN" | "CLOSED";
  employeeName: string;
  role: string;
  openedAt: string;
  closedAt: string | null;
  closedByName: string | null;
  cashSales: string;
  cardSales: string;
  totalSales: string;
  openingCash: string;
  expectedCash: string | null;
  countedCash: string | null;
  cashDifference: string | null;
}

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function ShiftsClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [rows, setRows] = useState<ShiftRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/reports/shifts?${reportFiltersToQuery(filters)}`);
      setRows(res.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju smena");
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
          <h1 className="text-2xl font-bold text-ink">Smene i rekonsilijacija gotovine</h1>
          <p className="mt-1 text-sm text-inkSoft">Otvorene i zatvorene smene, prijavljena gotovina i razlike</p>
        </div>
        <ReportFilters value={filters} onChange={setFilters} />
      </div>

      {error && <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      {loading || !rows ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <Card className="p-5">
          <EmptyState title="Nema smena u izabranom periodu." />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((s) => {
            const difference = s.cashDifference !== null ? Number(s.cashDifference) : null;
            const hasDiscrepancy = difference !== null && Math.abs(difference) > 0.005;
            return (
              <Card key={s.id} className="p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold text-ink">{s.employeeName}</span>
                    <span className="ml-2 text-sm text-inkSoft">{s.role}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={s.status === "OPEN" ? "gold" : "neutral"}>{s.status === "OPEN" ? "Otvorena" : "Zatvorena"}</Badge>
                    {hasDiscrepancy && <Badge tone="danger">Razlika u gotovini</Badge>}
                  </div>
                </div>

                <div className="mb-3 text-xs text-inkSoft">
                  {new Date(s.openedAt).toLocaleString("sr-RS")}
                  {s.closedAt && ` — ${new Date(s.closedAt).toLocaleString("sr-RS")}`}
                  {s.closedByName && s.closedByName !== s.employeeName && ` · zatvorio/la ${s.closedByName}`}
                </div>

                <div className="grid grid-cols-2 gap-3 border-t border-line pt-3 text-sm sm:grid-cols-4">
                  <div>
                    <p className="text-inkSoft">Prodaja</p>
                    <p className="font-medium text-ink">{formatMoney(s.totalSales)}</p>
                  </div>
                  <div>
                    <p className="text-inkSoft">Gotovina / Kartica</p>
                    <p className="font-medium text-ink">
                      {formatMoney(s.cashSales)} / {formatMoney(s.cardSales)}
                    </p>
                  </div>
                  {s.expectedCash !== null && (
                    <div>
                      <p className="text-inkSoft">Očekivano / Prijavljeno</p>
                      <p className="font-medium text-ink">
                        {formatMoney(s.expectedCash)} / {formatMoney(s.countedCash ?? "0")}
                      </p>
                    </div>
                  )}
                  {difference !== null && (
                    <div>
                      <p className="text-inkSoft">Razlika</p>
                      <p className={`font-semibold ${hasDiscrepancy ? "text-danger" : "text-success"}`}>
                        {difference > 0 ? "+" : ""}
                        {formatMoney(difference)}
                      </p>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
