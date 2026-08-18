"use client";

import { useEffect, useState } from "react";

export interface ReportFilterState {
  locationId: string; // "ALL" ili konkretan ID
  preset:
    | "today"
    | "yesterday"
    | "thisWeek"
    | "lastWeek"
    | "thisMonth"
    | "lastMonth"
    | "thisYear"
    | "last7days"
    | "last30days"
    | "custom";
  from?: string;
  to?: string;
}

interface LocationOption {
  id: string;
  name: string;
}

const PRESETS: { value: ReportFilterState["preset"]; label: string }[] = [
  { value: "today", label: "Danas" },
  { value: "yesterday", label: "Juče" },
  { value: "thisWeek", label: "Ova nedelja" },
  { value: "lastWeek", label: "Prošla nedelja" },
  { value: "thisMonth", label: "Ovaj mesec" },
  { value: "lastMonth", label: "Prošli mesec" },
  { value: "thisYear", label: "Ova godina" },
  { value: "custom", label: "Period" },
];

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

/**
 * Deljena traka filtera (lokacija + vremenski period) za sve Faza 5
 * izveštajne ekrane. Lokacije se učitavaju sa servera (samo one na koje
 * zaposleni ima pristup — vidi listAccessibleLocations) i select se
 * uopšte ne prikazuje ako postoji samo jedna (nema smisla birati).
 */
async function postAudit(reportType: string, filters: ReportFilterState) {
  try {
    await fetch("/api/admin/reports/print-audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportType, preset: filters.preset, from: filters.from, to: filters.to }),
    });
  } catch {
    // Audit log neuspeh ne sme blokirati štampu — vidi napomenu u
    // print-service.ts (isti princip: sporedna radnja nikad ne obara
    // glavnu, korisnik i dalje vidi/štampa izveštaj).
  }
}

export function ReportFilters({
  value,
  onChange,
  reportType,
}: {
  value: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
  /** Kad je prosleđeno, prikazuje dugmad Štampaj/Export CSV/Export PDF za taj izveštaj (zahtev #24/#26). */
  reportType?: string;
}) {
  const [locations, setLocations] = useState<LocationOption[]>([]);

  useEffect(() => {
    apiFetch("/api/admin/locations")
      .then((res) => setLocations(res.locations ?? []))
      .catch(() => setLocations([]));
  }, []);

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1 rounded-md bg-ink/[0.04] p-1">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            onClick={() => onChange({ ...value, preset: p.value })}
            className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
              value.preset === p.value ? "bg-white text-ink shadow-sm" : "text-inkSoft hover:text-ink"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {value.preset === "custom" && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={value.from ?? ""}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          />
          <span className="text-sm text-inkSoft">—</span>
          <input
            type="date"
            value={value.to ?? ""}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
            className="rounded-md border border-line px-2 py-1.5 text-sm"
          />
        </div>
      )}

      {locations.length > 1 && (
        <select
          value={value.locationId}
          onChange={(e) => onChange({ ...value, locationId: e.target.value })}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
        >
          <option value="ALL">Sve lokacije</option>
          {locations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {loc.name}
            </option>
          ))}
        </select>
      )}

      {reportType && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={async () => {
              await postAudit(reportType, value);
              window.print();
            }}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-inkSoft hover:text-ink"
          >
            Štampaj / PDF
          </button>
          <a
            href={`/api/admin/reports/export?reportType=${reportType}&${reportFiltersToQuery(value)}`}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-inkSoft hover:text-ink"
          >
            Export CSV
          </a>
        </div>
      )}
    </div>
  );
}

export function reportFiltersToQuery(filters: ReportFilterState): string {
  const params = new URLSearchParams({ locationId: filters.locationId, preset: filters.preset });
  if (filters.preset === "custom" && filters.from && filters.to) {
    params.set("from", filters.from);
    params.set("to", filters.to);
  }
  return params.toString();
}
