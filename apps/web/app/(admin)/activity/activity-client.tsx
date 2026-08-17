"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Skeleton } from "../../../components/ui/Skeleton";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../components/admin/ReportFilters";
import { SEVERITY_BADGE_TONE, type Severity } from "../../../components/admin/severity";

interface ActivityRow {
  id: string;
  label: string;
  employeeName: string;
  role: string;
  severity: Severity;
  isSuspicious: boolean;
  reason: string | null;
  createdAt: string;
}

async function apiFetch(url: string) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function ActivityClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [onlySuspicious, setOnlySuspicious] = useState(false);
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = reportFiltersToQuery(filters);
      const res = await apiFetch(`/api/admin/reports/activity?${query}&onlySuspicious=${onlySuspicious}`);
      setRows(res.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju evidencije");
    } finally {
      setLoading(false);
    }
  }, [filters, onlySuspicious]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Evidencija aktivnosti</h1>
          <p className="mt-1 text-sm text-inkSoft">Ko je šta uradio, kada i zašto</p>
        </div>
        <ReportFilters value={filters} onChange={setFilters} />
      </div>

      <label className="mb-4 flex w-fit items-center gap-2 text-sm text-inkSoft">
        <input type="checkbox" checked={onlySuspicious} onChange={(e) => setOnlySuspicious(e.target.checked)} />
        Prikaži samo istaknute stavke
      </label>

      {error && <div className="mb-6 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      {loading || !rows ? (
        <Skeleton className="h-64" />
      ) : rows.length === 0 ? (
        <Card className="p-5">
          <EmptyState title="Nema evidentirane aktivnosti u izabranom periodu." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink">{r.label}</span>
                    {r.isSuspicious && <Badge tone={SEVERITY_BADGE_TONE[r.severity]}>Istaknuto</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-inkSoft">
                    {r.employeeName} {r.role !== "?" && `· ${r.role}`}
                    {r.reason && ` · ${r.reason}`}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-inkSoft">{new Date(r.createdAt).toLocaleString("sr-RS")}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
