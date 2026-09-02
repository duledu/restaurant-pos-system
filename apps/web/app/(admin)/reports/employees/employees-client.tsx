"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@rcs/shared";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../../components/admin/ReportFilters";
import { ReportPrintHeader } from "../../../../components/admin/ReportPrintHeader";

interface EmployeeRow {
  employeeId: string;
  employeeName: string;
  role: string;
  completedPayments: number;
  sales: string;
  cashHandled: string;
  cardHandled: string;
  averagePaymentValue: string;
  discountTotal: string;
  voidCount: number;
  voidValue: string;
  shiftsClosedCount: number;
  cashDifference: string | null;
}

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function EmployeesClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [rows, setRows] = useState<EmployeeRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/reports/employees?${reportFiltersToQuery(filters)}`);
      setRows(res.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju aktivnosti");
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
          <h1 className="text-2xl font-bold text-ink">Aktivnost zaposlenih</h1>
          <p className="mt-1 text-sm text-inkSoft">Prodaja, gotovina/kartica i poništavanja po zaposlenom</p>
        </div>
        <ReportFilters value={filters} onChange={setFilters} reportType="employees" />
      </div>

      <ReportPrintHeader
        title="Aktivnost zaposlenih"
        periodLabel={filters.preset === "custom" ? `${filters.from ?? "?"} — ${filters.to ?? "?"}` : filters.preset}
      />

      {error && <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      {loading || !rows ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <Card className="p-5">
          <EmptyState title="Nema aktivnosti u izabranom periodu." />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map((r) => (
            <Card key={r.employeeId} className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="font-semibold text-ink">{r.employeeName}</p>
                  <p className="text-xs text-inkSoft">{r.role}</p>
                </div>
                <p className="text-lg font-bold text-ink">{formatMoney(r.sales)}</p>
              </div>
              <div className="grid grid-cols-2 gap-2 border-t border-line pt-3 text-sm">
                <div>
                  <p className="text-inkSoft">Zatvoreni računi</p>
                  <p className="font-medium text-ink">{r.completedPayments}</p>
                </div>
                <div>
                  <p className="text-inkSoft">Gotovina / Kartica</p>
                  <p className="font-medium text-ink">
                    {formatMoney(r.cashHandled)} / {formatMoney(r.cardHandled)}
                  </p>
                </div>
                <div>
                  <p className="text-inkSoft">Poništavanja</p>
                  <p className="font-medium text-ink">
                    {r.voidCount} {r.voidCount > 0 && `(${formatMoney(r.voidValue)})`}
                  </p>
                </div>
                <div>
                  <p className="text-inkSoft">Pros. iznos računa</p>
                  <p className="font-medium text-ink">{formatMoney(r.averagePaymentValue)}</p>
                </div>
                {Number(r.discountTotal) > 0 && (
                  <div>
                    <p className="text-inkSoft">Popusti</p>
                    <p className="font-medium text-ink">{formatMoney(r.discountTotal)}</p>
                  </div>
                )}
                {r.cashDifference !== null && (
                  <div>
                    <p className="text-inkSoft">Razlika u gotovini</p>
                    <p className={`font-medium ${Math.abs(Number(r.cashDifference)) > 0.005 ? "text-danger" : "text-success"}`}>
                      {Number(r.cashDifference) > 0 ? "+" : ""}
                      {formatMoney(r.cashDifference)}
                    </p>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
