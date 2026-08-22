"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { Badge } from "../../../../components/ui/Badge";
import { KpiCard } from "../../../../components/admin/KpiCard";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../../components/admin/ReportFilters";
import { ReportPrintHeader } from "../../../../components/admin/ReportPrintHeader";

type Severity = "INFO" | "WARNING" | "HIGH";

interface Overview {
  signalsCount: number;
  voidCount: number;
  voidValue: string;
  cashDiscrepancyAbsTotal: string;
  cashDiscrepancyShiftsCount: number;
  inventoryCorrectionsCount: number;
}

interface Signal {
  category: string;
  severity: Severity;
  employeeId?: string;
  employeeName?: string;
  itemName?: string;
  description: string;
  occurredAt: string;
  count?: number;
  value?: string;
  locationId?: string;
}

interface VoidEventRow {
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
  receiptNumber: number | null;
  isFullVoid: boolean;
  producedBeforeVoid: boolean;
}

interface CashDiscrepancyEventRow {
  shiftId: string;
  closedByName: string | null;
  openedAt: string;
  closedAt: string | null;
  openingCash: string;
  expectedCash: string | null;
  countedCash: string | null;
  cashDifference: string;
  kind: "shortage" | "overage";
}

interface InventoryAdjustmentEventRow {
  id: string;
  itemName: string;
  employeeName: string;
  type: "ADJUSTMENT" | "WRITE_OFF";
  quantityDelta: string;
  quantityBefore: string;
  quantityAfter: string;
  reason: string | null;
  createdAt: string;
}

interface EmployeeAntiFraudRow {
  employeeId: string;
  employeeName: string;
  role: string;
  paidSales: string;
  paidChecks: number;
  voidCount: number;
  voidValue: string;
  voidRateByChecks: number | null;
  voidRateByValue: number | null;
  shiftsClosedCount: number;
  netCashDifference: string | null;
  inventoryAdjustments: number;
  inventoryWriteOffs: number;
  signalsCount: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  FREQUENT_VOIDS: "Povećan broj storna",
  HIGH_VALUE_VOID: "Storno visoke vrednosti",
  REPEATED_VOID_REASON: "Ponovljen razlog storna",
  VOID_AFTER_PRODUCTION: "Storno posle pripreme",
  CASH_DISCREPANCY: "Razlika u gotovini",
  UNAUTHORIZED_ATTEMPTS: "Neovlašćeni pokušaji",
  LARGE_INVENTORY_WRITE_OFF: "Veliki otpis zaliha",
  FREQUENT_INVENTORY_ADJUSTMENTS: "Česte korekcije zaliha",
  REPEATED_ITEM_WRITE_OFF: "Ponovljen otpis artikla",
};

const SEVERITY_TONE: Record<Severity, "danger" | "warn" | "info"> = { HIGH: "danger", WARNING: "warn", INFO: "info" };
const SEVERITY_LABEL: Record<Severity, string> = { HIGH: "Za proveru", WARNING: "Neuobičajeno", INFO: "Info" };

const TABS = ["pregled", "storna", "gotovina", "zalihe", "zaposleni"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { pregled: "Pregled", storna: "Storna", gotovina: "Gotovina", zalihe: "Zalihe", zaposleni: "Zaposleni" };

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function downloadCsv(filename: string, header: string, lines: string[]) {
  const csv = [header, ...lines].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number | null | undefined): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("sr-RS", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function AntiFraudClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [tab, setTab] = useState<Tab>("pregled");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [voidRows, setVoidRows] = useState<VoidEventRow[]>([]);
  const [cashRows, setCashRows] = useState<CashDiscrepancyEventRow[]>([]);
  const [inventoryRows, setInventoryRows] = useState<InventoryAdjustmentEventRow[]>([]);
  const [employeeRows, setEmployeeRows] = useState<EmployeeAntiFraudRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = reportFiltersToQuery(filters);
    try {
      const [overviewRes, signalsRes, voidsRes, cashRes, inventoryRes, employeesRes] = await Promise.all([
        apiFetch(`/api/admin/antifraud/overview?${query}`),
        apiFetch(`/api/admin/antifraud/signals?${query}`),
        apiFetch(`/api/admin/antifraud/voids?${query}`),
        apiFetch(`/api/admin/antifraud/cash?${query}`),
        apiFetch(`/api/admin/antifraud/inventory?${query}`),
        apiFetch(`/api/admin/antifraud/employees?${query}`),
      ]);
      setOverview(overviewRes);
      setSignals(signalsRes.signals ?? []);
      setVoidRows(voidsRes.rows ?? []);
      setCashRows(cashRes.rows ?? []);
      setInventoryRows(inventoryRes.rows ?? []);
      setEmployeeRows(employeesRes.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju anti-fraud pregleda");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Anti-fraud pregled</h1>
          <p className="mt-1 text-sm text-inkSoft">
            Neuobičajena aktivnost za proveru — signali, ne optužbe. Vlasnik/menadžer tumači kontekst.
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
        title="Anti-fraud pregled"
        periodLabel={filters.preset === "custom" ? `${filters.from ?? "?"} — ${filters.to ?? "?"}` : filters.preset}
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="mb-6 flex gap-1 overflow-x-auto rounded-md bg-ink/[0.04] p-1 print:hidden">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`min-h-11 whitespace-nowrap rounded-sm px-4 py-2 text-sm font-semibold transition-colors ${
              tab === t ? "bg-white text-ink shadow-sm" : "text-inkSoft hover:text-ink"
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {loading || !overview ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard label="Za proveru" value={String(overview.signalsCount)} accent sub="signala u periodu" />
            <KpiCard label="Storno" value={`${overview.voidCount}`} sub={`${overview.voidValue} RSD`} />
            <KpiCard label="Razlika u gotovini" value={`${overview.cashDiscrepancyAbsTotal} RSD`} sub={`${overview.cashDiscrepancyShiftsCount} smena`} />
            <KpiCard label="Korekcije zaliha" value={String(overview.inventoryCorrectionsCount)} sub="ručnih unosa" />
          </div>
          <p className="mb-6 text-xs text-inkSoft">
            Ovi brojevi su signali za proveru, ne dokaz gubitka niti iznos ukradenog novca.
          </p>
        </>
      )}

      {tab === "pregled" && <PregledTab loading={loading} signals={signals} />}
      {tab === "storna" && <StornaTab loading={loading} rows={voidRows} />}
      {tab === "gotovina" && <GotovinaTab loading={loading} rows={cashRows} />}
      {tab === "zalihe" && <ZaliheTab loading={loading} rows={inventoryRows} />}
      {tab === "zaposleni" && <ZaposleniTab loading={loading} rows={employeeRows} />}
    </div>
  );
}

function SectionHeader({ title, onExport }: { title: string; onExport?: () => void }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-inkSoft uppercase tracking-wide">{title}</h2>
      {onExport && (
        <button
          onClick={onExport}
          className="flex min-h-11 items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-inkSoft hover:bg-ink/[0.04] print:hidden"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
          Izvezi CSV
        </button>
      )}
    </div>
  );
}

function PregledTab({ loading, signals }: { loading: boolean; signals: Signal[] }) {
  if (loading) return <div className="p-5"><Skeleton className="h-64" /></div>;
  if (signals.length === 0) {
    return <Card className="overflow-hidden"><div className="p-5"><EmptyState title="Nema signala za proveru u izabranom periodu." /></div></Card>;
  }
  return (
    <div>
      <SectionHeader
        title="Signali za proveru"
        onExport={() =>
          downloadCsv(
            "anti-fraud-signali.csv",
            "Ozbiljnost,Kategorija,Zaposleni/Artikal,Opis,Vreme",
            signals.map((s) =>
              [
                SEVERITY_LABEL[s.severity],
                CATEGORY_LABELS[s.category] ?? s.category,
                s.employeeName ?? s.itemName ?? "—",
                s.description,
                fmtDateTime(s.occurredAt),
              ]
                .map(csvCell)
                .join(",")
            )
          )
        }
      />
      <div className="space-y-2">
        {signals.map((s, i) => (
          <Card key={i} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge tone={SEVERITY_TONE[s.severity]}>{SEVERITY_LABEL[s.severity]}</Badge>
                <span className="text-sm font-semibold text-ink">{CATEGORY_LABELS[s.category] ?? s.category}</span>
              </div>
              <span className="text-xs text-inkSoft">{fmtDateTime(s.occurredAt)}</span>
            </div>
            <p className="mt-1.5 text-sm text-inkSoft">
              {(s.employeeName || s.itemName) && <span className="font-medium text-ink">{s.employeeName ?? s.itemName} — </span>}
              {s.description}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}

function StornaTab({ loading, rows }: { loading: boolean; rows: VoidEventRow[] }) {
  if (loading) return <div className="p-5"><Skeleton className="h-64" /></div>;
  if (rows.length === 0) {
    return <Card className="overflow-hidden"><div className="p-5"><EmptyState title="Nema storniranih stavki u izabranom periodu." /></div></Card>;
  }
  return (
    <div>
      <SectionHeader
        title="Stornirane stavke"
        onExport={() =>
          downloadCsv(
            "anti-fraud-storna.csv",
            "Zaposleni,Sto,Artikal,Količina,Vrednost,Razlog,Račun,Već pripremljeno,Vreme",
            rows.map((r) =>
              [
                r.employeeName,
                r.tableLabel,
                r.itemName,
                r.voidedQuantity,
                r.voidedValue,
                r.reasonLabel,
                r.receiptNumber ?? "—",
                r.producedBeforeVoid ? "DA" : "NE",
                fmtDateTime(r.voidedAt),
              ]
                .map(csvCell)
                .join(",")
            )
          )
        }
      />
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                <th className="px-4 py-3 font-medium">Zaposleni</th>
                <th className="px-4 py-3 font-medium">Račun / Sto</th>
                <th className="px-4 py-3 font-medium">Artikal</th>
                <th className="px-4 py-3 text-right font-medium">Kol.</th>
                <th className="px-4 py-3 text-right font-medium">Vrednost</th>
                <th className="px-4 py-3 font-medium">Razlog</th>
                <th className="px-4 py-3 font-medium">Napomena</th>
                <th className="px-4 py-3 font-medium">Vreme</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-ink/[0.02]">
                  <td className="px-4 py-3 font-medium text-ink">{r.employeeName}</td>
                  <td className="px-4 py-3 text-inkSoft">{r.receiptNumber ? `Račun #${r.receiptNumber}` : `Sto ${r.tableLabel}`}</td>
                  <td className="px-4 py-3 text-ink">{r.itemName}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.voidedQuantity}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-ink">{r.voidedValue} RSD</td>
                  <td className="px-4 py-3 text-inkSoft">{r.reasonLabel}</td>
                  <td className="px-4 py-3">
                    {r.producedBeforeVoid ? <Badge tone="warn">Već pripremljeno</Badge> : <span className="text-inkSoft">—</span>}
                  </td>
                  <td className="px-4 py-3 text-inkSoft">{fmtDateTime(r.voidedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function GotovinaTab({ loading, rows }: { loading: boolean; rows: CashDiscrepancyEventRow[] }) {
  if (loading) return <div className="p-5"><Skeleton className="h-64" /></div>;
  if (rows.length === 0) {
    return <Card className="overflow-hidden"><div className="p-5"><EmptyState title="Nema razlika u gotovini u izabranom periodu." /></div></Card>;
  }
  return (
    <div>
      <SectionHeader
        title="Razlike u gotovini pri zatvaranju smene"
        onExport={() =>
          downloadCsv(
            "anti-fraud-gotovina.csv",
            "Zatvorio,Otvoreno,Zatvoreno,Očekivano,Prebrojano,Razlika,Vrsta",
            rows.map((r) =>
              [
                r.closedByName ?? "?",
                fmtDateTime(r.openedAt),
                fmtDateTime(r.closedAt),
                r.expectedCash ?? "—",
                r.countedCash ?? "—",
                r.cashDifference,
                r.kind === "shortage" ? "Manjak" : "Višak",
              ]
                .map(csvCell)
                .join(",")
            )
          )
        }
      />
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                <th className="px-4 py-3 font-medium">Zatvorio</th>
                <th className="px-4 py-3 font-medium">Zatvoreno</th>
                <th className="px-4 py-3 text-right font-medium">Očekivano</th>
                <th className="px-4 py-3 text-right font-medium">Prebrojano</th>
                <th className="px-4 py-3 text-right font-medium">Razlika</th>
                <th className="px-4 py-3 font-medium">Vrsta</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.shiftId} className="border-b border-line last:border-0 hover:bg-ink/[0.02]">
                  <td className="px-4 py-3 font-medium text-ink">{r.closedByName ?? "?"}</td>
                  <td className="px-4 py-3 text-inkSoft">{fmtDateTime(r.closedAt)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{r.expectedCash ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{r.countedCash ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-ink">{r.cashDifference} RSD</td>
                  <td className="px-4 py-3">
                    <Badge tone={r.kind === "shortage" ? "danger" : "gold"}>{r.kind === "shortage" ? "Manjak" : "Višak"}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ZaliheTab({ loading, rows }: { loading: boolean; rows: InventoryAdjustmentEventRow[] }) {
  if (loading) return <div className="p-5"><Skeleton className="h-64" /></div>;
  if (rows.length === 0) {
    return <Card className="overflow-hidden"><div className="p-5"><EmptyState title="Nema ručnih korekcija zaliha u izabranom periodu." /></div></Card>;
  }
  return (
    <div>
      <SectionHeader
        title="Ručne korekcije i otpisi zaliha"
        onExport={() =>
          downloadCsv(
            "anti-fraud-zalihe.csv",
            "Artikal,Zaposleni,Tip,Delta,Pre,Posle,Razlog,Vreme",
            rows.map((r) =>
              [r.itemName, r.employeeName, r.type === "WRITE_OFF" ? "Otpis" : "Korekcija", r.quantityDelta, r.quantityBefore, r.quantityAfter, r.reason ?? "—", fmtDateTime(r.createdAt)]
                .map(csvCell)
                .join(",")
            )
          )
        }
      />
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                <th className="px-4 py-3 font-medium">Artikal</th>
                <th className="px-4 py-3 font-medium">Zaposleni</th>
                <th className="px-4 py-3 font-medium">Tip</th>
                <th className="px-4 py-3 text-right font-medium">Promena</th>
                <th className="px-4 py-3 font-medium">Razlog</th>
                <th className="px-4 py-3 font-medium">Vreme</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const delta = Number(r.quantityDelta);
                const isLargeWriteOff = r.type === "WRITE_OFF" && Math.abs(delta) >= 10;
                return (
                  <tr key={r.id} className="border-b border-line last:border-0 hover:bg-ink/[0.02]">
                    <td className="px-4 py-3 font-medium text-ink">{r.itemName}</td>
                    <td className="px-4 py-3 text-inkSoft">{r.employeeName}</td>
                    <td className="px-4 py-3">
                      <Badge tone={r.type === "WRITE_OFF" ? "danger" : "neutral"}>{r.type === "WRITE_OFF" ? "Otpis" : "Korekcija"}</Badge>
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums font-medium ${isLargeWriteOff ? "text-danger" : "text-ink"}`}>
                      {delta > 0 ? "+" : ""}{r.quantityDelta} ({r.quantityBefore} → {r.quantityAfter})
                    </td>
                    <td className="px-4 py-3 text-inkSoft">{r.reason ?? "—"}</td>
                    <td className="px-4 py-3 text-inkSoft">{fmtDateTime(r.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ZaposleniTab({ loading, rows }: { loading: boolean; rows: EmployeeAntiFraudRow[] }) {
  if (loading) return <div className="p-5"><Skeleton className="h-64" /></div>;
  if (rows.length === 0) {
    return <Card className="overflow-hidden"><div className="p-5"><EmptyState title="Nema aktivnosti zaposlenih u izabranom periodu." /></div></Card>;
  }
  return (
    <div>
      <SectionHeader
        title="Pregled po zaposlenom"
        onExport={() =>
          downloadCsv(
            "anti-fraud-zaposleni.csv",
            "Zaposleni,Prodaja,Naplaćeni računi,Storno (broj),Storno (vrednost),Stopa storna (%),Zatvorene smene,Neto razlika gotovine,Korekcije zaliha,Otpisi,Signali",
            rows.map((r) =>
              [
                r.employeeName,
                r.paidSales,
                r.paidChecks,
                r.voidCount,
                r.voidValue,
                r.voidRateByChecks !== null ? (r.voidRateByChecks * 100).toFixed(1) : "—",
                r.shiftsClosedCount,
                r.netCashDifference ?? "—",
                r.inventoryAdjustments,
                r.inventoryWriteOffs,
                r.signalsCount,
              ]
                .map(csvCell)
                .join(",")
            )
          )
        }
      />
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                <th className="px-4 py-3 font-medium">Zaposleni</th>
                <th className="px-4 py-3 text-right font-medium">Prodaja</th>
                <th className="px-4 py-3 text-right font-medium">Računi</th>
                <th className="px-4 py-3 text-right font-medium">Storno</th>
                <th className="px-4 py-3 text-right font-medium">Stopa storna</th>
                <th className="px-4 py-3 text-right font-medium">Smene</th>
                <th className="px-4 py-3 text-right font-medium">Neto gotovina</th>
                <th className="px-4 py-3 text-right font-medium">Korekcije/otpisi</th>
                <th className="px-4 py-3 text-right font-medium">Signali</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId} className="border-b border-line last:border-0 hover:bg-ink/[0.02]">
                  <td className="px-4 py-3 font-medium text-ink">{r.employeeName}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink">{r.paidSales} RSD</td>
                  <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{r.paidChecks}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{r.voidCount} ({r.voidValue} RSD)</td>
                  <td className="px-4 py-3 text-right tabular-nums text-inkSoft">
                    {r.voidRateByChecks !== null ? `${(r.voidRateByChecks * 100).toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{r.shiftsClosedCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{r.netCashDifference ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-inkSoft">{r.inventoryAdjustments + r.inventoryWriteOffs}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.signalsCount > 0 ? <Badge tone="warn">{r.signalsCount}</Badge> : <span className="text-inkSoft">0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mt-3 text-xs text-inkSoft">
        Ova tabela je pregled aktivnosti, ne rang-lista niti presuda. &quot;Signali&quot; je broj već objašnjenih obrazaca iz sekcije
        Pregled — proverite kontekst pre bilo kakvog zaključka.
      </p>
    </div>
  );
}
