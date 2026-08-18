"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@rcs/shared";
import { Card } from "../../../../components/ui/Card";
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
  grossSales: string;
  netSales: string;
  discountTotal: string;
  taxTotal: string;
  voidTotal: string;
}
interface ShiftRow {
  id: string;
  status: "OPEN" | "CLOSED";
  employeeName: string;
  totalSales: string;
}
interface EmployeeRow {
  employeeId: string;
  employeeName: string;
  sales: string;
  completedOrders: number;
}
interface DailySummary {
  label: string;
  generatedAt: string;
  sales: SalesSummary;
  shifts: ShiftRow[];
  employees: EmployeeRow[];
}
interface ThermalSummary {
  totalSales: string;
  cashSales: string;
  cardSales: string;
  completedOrders: number;
  averageOrderValue: string;
  voidTotal: string;
  discountTotal: string;
  currency: string;
  generatedAt: string;
}

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

/**
 * Faza 6 — Z-stil menadžerski dnevni izveštaj. NAMERNO nije nazvan
 * "fiskalni Z izveštaj" (nema fiskalizacione integracije) — to je
 * eksplicitno u naslovu koji vraća getDailySummary (report.label).
 */
export function DailySummaryClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [report, setReport] = useState<DailySummary | null>(null);
  const [thermal, setThermal] = useState<ThermalSummary | null>(null);
  const [showThermal, setShowThermal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = reportFiltersToQuery(filters);
    try {
      const [summary, thermalSummary] = await Promise.all([
        apiFetch(`/api/admin/reports/daily-summary?${query}`),
        apiFetch(`/api/admin/reports/daily-summary/thermal?${query}`),
      ]);
      setReport(summary);
      setThermal(thermalSummary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju izveštaja");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const s = report?.sales;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{report?.label ?? "TableCore dnevni izveštaj"}</h1>
          <p className="mt-1 text-sm text-inkSoft">
            Menadžerski pregled dana — NIJE zakonski fiskalni Z izveštaj (nema fiskalizacione integracije)
          </p>
        </div>
        <div className="no-print flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowThermal((v) => !v)}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-inkSoft hover:text-ink"
          >
            {showThermal ? "Sakrij termalni prikaz" : "Termalni prikaz (80mm)"}
          </button>
          <ReportFilters value={filters} onChange={setFilters} reportType="daily-summary" />
        </div>
      </div>

      <ReportPrintHeader
        title={report?.label ?? "TableCore dnevni izveštaj"}
        periodLabel={filters.preset === "custom" ? `${filters.from ?? "?"} — ${filters.to ?? "?"}` : filters.preset}
      />

      {error && <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      {loading || !s ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard label="Promet (neto)" value={formatMoney(s.netSales, s.currency)} accent />
            <KpiCard label="Gotovina" value={formatMoney(s.cashSales, s.currency)} />
            <KpiCard label="Kartica" value={formatMoney(s.cardSales, s.currency)} />
            <KpiCard label="Računa" value={String(s.completedOrders)} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard label="Prosečan račun" value={formatMoney(s.averageOrderValue, s.currency)} />
            <KpiCard label="Popusti" value={formatMoney(s.discountTotal, s.currency)} />
            <KpiCard label="Storna" value={formatMoney(s.voidTotal, s.currency)} />
            <KpiCard label="PDV" value={formatMoney(s.taxTotal, s.currency)} />
          </div>

          <section className="mt-8">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Smene</h2>
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                      <th className="px-4 py-3 font-medium">Zaposleni</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 text-right font-medium">Prodaja</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report?.shifts ?? []).map((row) => (
                      <tr key={row.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-3 text-ink">{row.employeeName}</td>
                        <td className="px-4 py-3 text-inkSoft">{row.status === "OPEN" ? "Otvorena" : "Zatvorena"}</td>
                        <td className="px-4 py-3 text-right font-medium text-ink">{formatMoney(row.totalSales, s.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </section>

          <section className="mt-8">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-inkSoft">Zaposleni</h2>
            <Card className="overflow-hidden">
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
                    {(report?.employees ?? []).map((row) => (
                      <tr key={row.employeeId} className="border-b border-line last:border-0">
                        <td className="px-4 py-3 text-ink">{row.employeeName}</td>
                        <td className="px-4 py-3 text-inkSoft">{row.completedOrders}</td>
                        <td className="px-4 py-3 text-right font-medium text-ink">{formatMoney(row.sales, s.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </section>
        </>
      )}

      {showThermal && thermal && (
        <div className="print-ticket-root" style={{ position: "static", left: "auto", marginTop: "2rem" }}>
          <div className="print-ticket" style={{ border: "1px solid #ccc" }}>
            <div className="t-header">TABLECORE</div>
            <div className="t-station">DNEVNI IZVEŠTAJ</div>
            <div className="t-meta t-center">{new Date(thermal.generatedAt).toLocaleDateString("sr-RS")}</div>
            <hr className="t-sep" />
            <div className="t-line"><span>PROMET</span><span>{formatMoney(thermal.totalSales, thermal.currency)}</span></div>
            <hr className="t-sep" />
            <div className="t-line"><span>GOTOVINA</span><span>{formatMoney(thermal.cashSales, thermal.currency)}</span></div>
            <div className="t-line"><span>KARTICE</span><span>{formatMoney(thermal.cardSales, thermal.currency)}</span></div>
            <hr className="t-sep" />
            <div className="t-line"><span>RAČUNA</span><span>{thermal.completedOrders}</span></div>
            <div className="t-line"><span>PROSEČAN</span><span>{formatMoney(thermal.averageOrderValue, thermal.currency)}</span></div>
            <hr className="t-sep" />
            <div className="t-line"><span>STORNO</span><span>{formatMoney(thermal.voidTotal, thermal.currency)}</span></div>
            <div className="t-line"><span>POPUSTI</span><span>{formatMoney(thermal.discountTotal, thermal.currency)}</span></div>
            <hr className="t-sep" />
            <div className="t-footer">Generated: {new Date(thermal.generatedAt).toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" })}</div>
          </div>
        </div>
      )}
    </div>
  );
}
