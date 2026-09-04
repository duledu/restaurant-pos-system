"use client";

import { useCallback, useEffect, useState } from "react";
import { LogoutButton } from "../ui/LogoutButton";
import { AppLogo } from "../branding/AppLogo";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { ReportPrintHeader } from "../admin/ReportPrintHeader";
import { StationEmployeeTable, type EmployeeStationRow } from "./StationEmployeeTable";

type Preset = "today" | "yesterday" | "thisWeek" | "lastWeek" | "thisMonth" | "custom";

interface StationItemTotal {
  name: string;
  quantity: number;
}

interface StationActivityRow {
  time: string;
  table: string;
  orderNumber: string;
  itemName: string;
  quantity: number;
  acceptedBy: string;
  readyBy: string;
  durationMinutes: number | null;
}

interface StationPerformance {
  avgMinutes: number | null;
  fastestMinutes: number | null;
  longestMinutes: number | null;
  pairsCount: number;
}

interface StationEmployeeReport {
  range: { from: string; to: string };
  employees: EmployeeStationRow[];
  employeeTotals: { acceptedCount: number; readyCount: number };
  itemTotals: StationItemTotal[];
  performance: StationPerformance;
  activity: StationActivityRow[];
  selectedEmployeeId: string | null;
}

const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Danas" },
  { value: "yesterday", label: "Juče" },
  { value: "thisWeek", label: "Ova nedelja" },
  { value: "lastWeek", label: "Prošla nedelja" },
  { value: "thisMonth", label: "Ovaj mesec" },
  { value: "custom", label: "Period" },
];

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("sr-RS", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatMinutes(minutes: number | null): string {
  return minutes == null ? "—" : `${minutes} min`;
}

/**
 * Faza 12/13 — izveštaj po zaposlenom, dostupan direktno Kuhinji/Šanku (ne
 * samo Admin panelu, vidi apps/web/app/kitchen/report/page.tsx). Namerno
 * bez selektora lokacije (kao ni AvailabilityClient) — kuhinjski/šank
 * radnik radi na SVOJOJ dodeljenoj lokaciji, ne bira između više njih.
 *
 * Faza 13 dodaje: prilagođeni period (Od/Do), filter po zaposlenom (klik na
 * red tabele ili padajući meni), pregled po artiklima, metrike vremena
 * pripreme (prosek/najbrže/najduže — samo iz stvarnih PRIHVATI->SPREMNO
 * parova, nikad izmišljeno) i detaljnu aktivnost stavka-po-stavka sa punom
 * PRIHVATI/SPREMNO atribucijom, plus A4 štampu (print-report.css — potpuno
 * odvojena od 58/80mm termalne arhitekture, vidi print-thermal.css).
 */
export function StationReportClient({ station, title }: { station: "KITCHEN" | "BAR"; title: string }) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [report, setReport] = useState<StationEmployeeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (preset === "custom" && (!customFrom || !customTo)) return;
    setLoading(true);
    setError(null);
    try {
      let loc = locationId;
      if (!loc) {
        const me = await apiFetch("/api/pos/me");
        loc = me.locationIds[0];
        setLocationId(loc);
      }
      const params = new URLSearchParams({ locationId: loc ?? "ALL", preset });
      if (preset === "custom") {
        params.set("from", customFrom);
        params.set("to", customTo);
      }
      if (employeeId) params.set("employeeId", employeeId);
      const path = station === "KITCHEN" ? "/api/production/kitchen/report" : "/api/production/bar/report";
      const data = await apiFetch(`${path}?${params.toString()}`);
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju izveštaja");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, customFrom, customTo, employeeId, station]);

  useEffect(() => {
    load();
  }, [load]);

  const employees = report?.employees ?? [];
  const selectedEmployeeName = employeeId ? employees.find((e) => e.employeeId === employeeId)?.employeeName ?? null : null;
  const periodLabel =
    preset === "custom" ? `${customFrom || "?"} — ${customTo || "?"}` : PRESETS.find((p) => p.value === preset)?.label ?? preset;

  return (
    <div className="station-report-page min-h-screen bg-graphite-900 p-3 sm:p-5">
      <div className="no-print mb-5 flex items-center justify-between border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <AppLogo variant="mark" theme="dark" size="sm" />
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.2em] text-cream-300/70">TableCore · produkcija</p>
            <h1 className="text-2xl font-bold tracking-tight text-cream-100">{title}</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-11 rounded-md border border-white/15 px-3 py-2 text-sm font-semibold text-cream-100 hover:bg-white/[.08]"
          >
            Štampaj izveštaj
          </button>
          <LogoutButton theme="dark" />
        </div>
      </div>

      <ReportPrintHeader
        title={`Izveštaj ${station === "KITCHEN" ? "kuhinje" : "šanka"}`}
        periodLabel={selectedEmployeeName ? `${periodLabel} · ${selectedEmployeeName}` : periodLabel}
      />

      <div className="no-print mb-5 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-white/[.05] p-1">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPreset(p.value)}
              className={`min-h-11 whitespace-nowrap rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                preset === p.value ? "bg-gold text-white" : "text-cream-300/70 hover:bg-white/[.08]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === "custom" && (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="min-h-11 rounded-md border border-white/15 bg-graphite-800 px-2 py-1.5 text-sm text-cream-100"
            />
            <span className="text-sm text-cream-300/60">—</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="min-h-11 rounded-md border border-white/15 bg-graphite-800 px-2 py-1.5 text-sm text-cream-100"
            />
          </div>
        )}

        {employees.length > 0 && (
          <select
            value={employeeId ?? "ALL"}
            onChange={(e) => setEmployeeId(e.target.value === "ALL" ? null : e.target.value)}
            className="min-h-11 rounded-md border border-white/15 bg-graphite-800 px-3 py-2 text-sm font-medium text-cream-100"
          >
            <option value="ALL">Svi zaposleni</option>
            {employees.map((e) => (
              <option key={e.employeeId} value={e.employeeId}>
                {e.employeeName}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <div className="no-print mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      {loading ? (
        <div className="py-24 text-center text-cream-300/60">Učitavanje…</div>
      ) : (
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-cream-300/60">Pregled po zaposlenom</h2>
            <div className="rounded-lg bg-white p-1">
              <StationEmployeeTable
                employees={employees}
                employeeTotals={report?.employeeTotals ?? { acceptedCount: 0, readyCount: 0 }}
                selectedEmployeeId={employeeId}
                onSelectEmployee={setEmployeeId}
              />
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-cream-300/60">
              Vreme pripreme{selectedEmployeeName ? ` — ${selectedEmployeeName}` : ""}
            </h2>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              {[
                { label: "Prosečno", value: formatMinutes(report?.performance.avgMinutes ?? null) },
                { label: "Najbrže", value: formatMinutes(report?.performance.fastestMinutes ?? null) },
                { label: "Najduže", value: formatMinutes(report?.performance.longestMinutes ?? null) },
              ].map((kpi) => (
                <div key={kpi.label} className="rounded-lg bg-white p-3 sm:p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-inkSoft">{kpi.label}</p>
                  <p className="mt-1 text-lg font-bold text-ink sm:text-xl">{kpi.value}</p>
                </div>
              ))}
            </div>
            {report && report.performance.pairsCount === 0 && (
              <p className="mt-2 text-xs text-cream-300/50">
                Nema dovoljno podataka (potreban je i PRIHVATI i SPREMNO događaj za istu stavku u ovom periodu).
              </p>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-cream-300/60">
              Artikli{selectedEmployeeName ? ` — ${selectedEmployeeName}` : ""}
            </h2>
            <Card className="overflow-hidden">
              {!report || report.itemTotals.length === 0 ? (
                <div className="p-5">
                  <EmptyState title="Nema završenih artikala u izabranom periodu." />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                        <th className="px-4 py-3 font-medium">Artikal</th>
                        <th className="px-4 py-3 text-right font-medium">Količina</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.itemTotals.map((row) => (
                        <tr key={row.name} className="border-b border-line last:border-0 hover:bg-ink/[0.02]">
                          <td className="px-4 py-3 font-medium text-ink">{row.name}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-ink">{row.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </section>

          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-cream-300/60">
              Detaljna aktivnost{selectedEmployeeName ? ` — ${selectedEmployeeName}` : ""}
            </h2>
            <Card className="overflow-hidden">
              {!report || report.activity.length === 0 ? (
                <div className="p-5">
                  <EmptyState title="Nema evidentirane aktivnosti u izabranom periodu." />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-inkSoft">
                        <th className="px-3 py-3 font-medium">Vreme</th>
                        <th className="px-3 py-3 font-medium">Sto</th>
                        <th className="px-3 py-3 font-medium">Porudžbina</th>
                        <th className="px-3 py-3 font-medium">Stavka</th>
                        <th className="px-3 py-3 text-right font-medium">Kol.</th>
                        <th className="px-3 py-3 font-medium">Prihvatio</th>
                        <th className="px-3 py-3 font-medium">Spremio</th>
                        <th className="px-3 py-3 text-right font-medium">Trajanje</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.activity.map((row, i) => (
                        <tr key={`${row.orderNumber}-${row.itemName}-${i}`} className="border-b border-line last:border-0 hover:bg-ink/[0.02]">
                          <td className="whitespace-nowrap px-3 py-2.5 text-xs text-inkSoft">{formatDateTime(row.time)}</td>
                          <td className="px-3 py-2.5 text-ink">{row.table}</td>
                          <td className="px-3 py-2.5 font-mono text-xs text-inkSoft">{row.orderNumber}</td>
                          <td className="px-3 py-2.5 text-ink">{row.itemName}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-ink">{row.quantity}</td>
                          <td className="px-3 py-2.5 text-ink">{row.acceptedBy}</td>
                          <td className="px-3 py-2.5 text-ink">{row.readyBy}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-ink">{formatMinutes(row.durationMinutes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </section>

          <p className="no-print text-xs text-cream-300/50">
            Prihvaćeno = stavke koje si lično prihvatio (PRIHVATI). Spremno = stavke koje si označio spremnim (SPREMNO).
            Artikli/vreme pripreme se računaju po stavkama koje si TI označio spremnim; detaljna aktivnost prikazuje i
            stavke koje si samo prihvatio. Preuzimanje je konobarska radnja i ne broji se ovde. Prihvatio se prikazuje
            kao „Nepoznato&rdquo; kad PRIHVATI događaj ne postoji u periodu (npr. starija stavka od pre uvođenja ovog toka).
          </p>
        </div>
      )}
    </div>
  );
}
