"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@rcs/shared";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { ReportFilters, reportFiltersToQuery, type ReportFilterState } from "../../../../components/admin/ReportFilters";
import { ReportPrintHeader } from "../../../../components/admin/ReportPrintHeader";

// ─── Types ────────────────────────────────────────────────────────────────────

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

interface ActiveShift {
  id: string;
  openedAt: string;
  status: "OPEN" | "CLOSED";
}

interface ShiftSummary {
  shift: ActiveShift;
  openingCash: string;
  cashTotal: string;
  cardTotal: string;
  expectedCash: string;
  totalRevenue: string;
  orderCount: number;
  openOrders: { id: string; tableLabel: string; status: string }[];
  canClose: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("sr-RS", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// ─── Close shift modal ────────────────────────────────────────────────────────

function CloseShiftModal({
  summary,
  onClose,
  onDone,
}: {
  summary: ShiftSummary;
  onClose: () => void;
  onDone: () => void;
}) {
  const [countedCash, setCountedCash] = useState("");
  const [closing, setClosing] = useState(false);
  const [err, setErr] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const expected = Number(summary.expectedCash);
  const counted = countedCash !== "" ? Number(countedCash) : null;
  const difference = counted !== null && !Number.isNaN(counted) ? counted - expected : null;
  const canSubmit = summary.canClose && counted !== null && !Number.isNaN(counted) && counted >= 0 && confirmed;

  async function submit() {
    if (!canSubmit || closing) return;
    setClosing(true);
    setErr("");
    try {
      await apiFetch(`/api/pos/shift/${summary.shift.id}/close`, {
        method: "POST",
        body: JSON.stringify({ countedCash: counted }),
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Greška pri zatvaranju smene");
    } finally {
      setClosing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-graphite-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md animate-slide-up rounded-lg bg-white shadow-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-base font-semibold text-ink">Zatvaranje smene</h2>
          <button
            onClick={onClose}
            aria-label="Zatvori"
            className="flex h-11 w-11 items-center justify-center rounded-md text-ink/50 hover:bg-ink/[.05] hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Shift info */}
          <div className="rounded-md bg-ink/[.02] border border-line/70 px-4 py-3 text-sm space-y-1.5">
            <div className="flex justify-between text-inkSoft">
              <span>Otvorena</span>
              <span>{fmtTime(summary.shift.openedAt)}</span>
            </div>
            <div className="flex justify-between text-inkSoft">
              <span>Broj naplaćenih računa</span>
              <span>{summary.orderCount}</span>
            </div>
          </div>

          {/* Open orders warning */}
          {summary.openOrders.length > 0 && (
            <div className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
              Postoje otvoreni računi na stolovima:{" "}
              <strong>{summary.openOrders.map((o) => o.tableLabel).join(", ")}</strong>.
              Naplati ili otkaži pre zatvaranja smene.
            </div>
          )}

          {/* Sales summary */}
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between text-inkSoft">
              <span>Gotovinska prodaja</span>
              <span>{formatMoney(summary.cashTotal)}</span>
            </div>
            <div className="flex justify-between text-inkSoft">
              <span>Kartična prodaja</span>
              <span>{formatMoney(summary.cardTotal)}</span>
            </div>
            <div className="flex justify-between font-semibold text-ink border-t border-line pt-1.5">
              <span>Ukupan promet</span>
              <span>{formatMoney(summary.totalRevenue)}</span>
            </div>
          </div>

          {/* Cash reconciliation */}
          <div className="rounded-md border border-line bg-cream-200/60 px-4 py-3 space-y-1.5 text-sm">
            <div className="flex justify-between text-inkSoft">
              <span>Početni polog</span>
              <span>{formatMoney(summary.openingCash)}</span>
            </div>
            <div className="flex justify-between font-semibold text-ink">
              <span>Očekivano u kasi</span>
              <span>{formatMoney(summary.expectedCash)}</span>
            </div>
          </div>

          {/* Counted cash input */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">
              Prebrojana gotovina <span className="text-danger">*</span>
            </label>
            <input
              autoFocus
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              className="w-full rounded-md border border-line px-3 py-2.5 text-base text-ink placeholder:text-ink/35 focus:border-gold focus:outline-none"
              placeholder={`npr. ${expected.toFixed(2)}`}
              value={countedCash}
              onChange={(e) => setCountedCash(e.target.value)}
            />
            {difference !== null && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                <span className="text-inkSoft">Razlika:</span>
                <span
                  className={`font-semibold ${
                    difference === 0
                      ? "text-success"
                      : difference > 0
                      ? "text-success"
                      : "text-danger"
                  }`}
                >
                  {difference > 0 ? "+" : ""}
                  {formatMoney(difference)}
                </span>
                {difference !== 0 && (
                  <span className="text-inkSoft text-xs">
                    ({difference > 0 ? "višak" : "manjak"})
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Confirmation checkbox */}
          {counted !== null && !Number.isNaN(counted) && (
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-gold"
              />
              <span className="text-sm text-ink">
                Potvrđujem da je prebrojana gotovina tačna i da želim da zatvorim smenu.
                {difference !== null && difference !== 0 && (
                  <span className="block mt-1 text-danger font-medium">
                    Razlika od {difference > 0 ? "+" : ""}{formatMoney(difference)} će biti zabeležena i vidljiva u izveštaju.
                  </span>
                )}
              </span>
            </label>
          )}

          {err && (
            <div className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
              {err}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose}>Otkaži</Button>
            <Button
              variant="danger"
              onClick={submit}
              loading={closing}
              disabled={!canSubmit}
            >
              {closing ? "Zatvaranje…" : "Zatvori smenu"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Active shift panel ───────────────────────────────────────────────────────

function ActiveShiftPanel({ locationId, onClosed }: { locationId: string; onClosed: () => void }) {
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const shiftRes = await apiFetch(`/api/pos/shift?locationId=${locationId}`);
      if (!shiftRes.shift || shiftRes.shift.status !== "OPEN") {
        setSummary(null);
        return;
      }
      const s: ShiftSummary = await apiFetch(`/api/pos/shift/${shiftRes.shift.id}`);
      setSummary(s);
    } catch {
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Skeleton className="mb-5 h-24 w-full rounded-lg" />;
  if (!summary) return null;

  return (
    <>
      <Card className="mb-5 border-gold/30 bg-gold-soft/30 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Badge tone="gold">Otvorena smena</Badge>
              <span className="text-xs text-inkSoft">od {fmtTime(summary.shift.openedAt)}</span>
            </div>
            <div className="flex flex-wrap gap-4 text-sm text-ink">
              <span>Promet: <strong>{formatMoney(summary.totalRevenue)}</strong></span>
              <span>Gotovina: <strong>{formatMoney(summary.cashTotal)}</strong></span>
              <span>Kartica: <strong>{formatMoney(summary.cardTotal)}</strong></span>
              <span>Računi: <strong>{summary.orderCount}</strong></span>
            </div>
            {summary.openOrders.length > 0 && (
              <p className="mt-1 text-xs text-warn">
                {summary.openOrders.length} otvoreni{summary.openOrders.length === 1 ? " račun" : " računa"} sprečavaju zatvaranje
              </p>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowModal(true)}
          >
            Zatvori smenu
          </Button>
        </div>
      </Card>

      {showModal && (
        <CloseShiftModal
          summary={summary}
          onClose={() => setShowModal(false)}
          onDone={() => {
            setShowModal(false);
            setSummary(null);
            onClosed();
          }}
        />
      )}
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ShiftsClient() {
  const [filters, setFilters] = useState<ReportFilterState>({ locationId: "ALL", preset: "today" });
  const [rows, setRows] = useState<ShiftRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

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

  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Smene i rekonsilijacija gotovine</h1>
          <p className="mt-1 text-sm text-inkSoft">Otvorene i zatvorene smene, prijavljena gotovina i razlike</p>
        </div>
        <ReportFilters value={filters} onChange={setFilters} reportType="shifts" />
      </div>

      <ReportPrintHeader
        title="Izveštaj o smenama"
        periodLabel={filters.preset === "custom" ? `${filters.from ?? "?"} — ${filters.to ?? "?"}` : filters.preset}
      />

      {/* Active shift panel — shown only when a specific location is selected */}
      {filters.locationId !== "ALL" && (
        <ActiveShiftPanel
          key={`${filters.locationId}-${refreshKey}`}
          locationId={filters.locationId}
          onClosed={() => { setRefreshKey((k) => k + 1); }}
        />
      )}

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
                    <Badge tone={s.status === "OPEN" ? "gold" : "neutral"}>
                      {s.status === "OPEN" ? "Otvorena" : "Zatvorena"}
                    </Badge>
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
