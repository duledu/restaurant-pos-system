"use client";

import { useCallback, useEffect, useState } from "react";
import { LogoutButton } from "../ui/LogoutButton";
import { AppLogo } from "../branding/AppLogo";
import { StationEmployeeTable, type EmployeeStationRow } from "./StationEmployeeTable";
import { reportFiltersToQuery, type ReportFilterState } from "../admin/ReportFilters";

interface StationEmployeeReport {
  range: { from: string; to: string };
  employees: EmployeeStationRow[];
  employeeTotals: { acceptedCount: number; readyCount: number };
}

const PRESETS: { value: ReportFilterState["preset"]; label: string }[] = [
  { value: "today", label: "Danas" },
  { value: "yesterday", label: "Juče" },
  { value: "thisWeek", label: "Ova nedelja" },
  { value: "lastWeek", label: "Prošla nedelja" },
  { value: "thisMonth", label: "Ovaj mesec" },
];

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

/**
 * Faza 12 — izveštaj po zaposlenom, dostupan direktno Kuhinji/Šanku (ne
 * samo Admin panelu) — vidi apps/web/app/kitchen/report/page.tsx. Namerno
 * bez selektora lokacije (kao ni AvailabilityClient) — kuhinjski/šank
 * radnik radi na SVOJOJ dodeljenoj lokaciji, ne bira između više njih.
 */
export function StationReportClient({ station, title }: { station: "KITCHEN" | "BAR"; title: string }) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [preset, setPreset] = useState<ReportFilterState["preset"]>("today");
  const [report, setReport] = useState<StationEmployeeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let loc = locationId;
      if (!loc) {
        const me = await apiFetch("/api/pos/me");
        loc = me.locationIds[0];
        setLocationId(loc);
      }
      const query = reportFiltersToQuery({ locationId: loc ?? "ALL", preset });
      const path = station === "KITCHEN" ? "/api/production/kitchen/report" : "/api/production/bar/report";
      const data = await apiFetch(`${path}?${query}`);
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju izveštaja");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, station]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="min-h-screen bg-graphite-900 p-3 sm:p-5">
      <div className="mb-5 flex items-center justify-between border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <AppLogo variant="mark" theme="dark" size="sm" />
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.2em] text-cream-300/70">TableCore · produkcija</p>
            <h1 className="text-2xl font-bold tracking-tight text-cream-100">{title}</h1>
          </div>
        </div>
        <LogoutButton theme="dark" />
      </div>

      <div className="mb-5 flex flex-wrap gap-1 rounded-lg bg-white/[.05] p-1">
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

      {error && <div className="mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      {loading ? (
        <div className="py-24 text-center text-cream-300/60">Učitavanje…</div>
      ) : (
        <div className="rounded-lg bg-white p-1">
          <StationEmployeeTable
            employees={report?.employees ?? []}
            employeeTotals={report?.employeeTotals ?? { acceptedCount: 0, readyCount: 0 }}
          />
        </div>
      )}

      <p className="mt-4 text-xs text-cream-300/50">
        Prihvaćeno = stavke koje si lično prihvatio (PRIHVATI). Spremno = stavke koje si označio
        spremnim (SPREMNO). Preuzimanje je konobarska radnja i ne broji se ovde.
      </p>
    </div>
  );
}
