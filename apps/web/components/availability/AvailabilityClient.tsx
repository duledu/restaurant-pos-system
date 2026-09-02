"use client";

import { useEffect, useState, useCallback } from "react";
import { LogoutButton } from "../ui/LogoutButton";
import { AppLogo } from "../branding/AppLogo";

interface AvailabilityRow {
  menuItemId: string;
  name: string;
  preparationStation: string;
  isAvailable: boolean;
  reasonCode: string | null;
  reasonLabel: string | null;
  note: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
}

const REASON_OPTIONS: { code: string; label: string }[] = [
  { code: "NEMA_PROIZVODA", label: "Nema proizvoda" },
  { code: "NEMA_SIROVINE_FIZICKI", label: "Nema sirovine fizički" },
  { code: "OPREMA_KVAR", label: "Oprema / kvar" },
  { code: "NEMA_STRUJE_GASA", label: "Nema struje / gasa" },
  { code: "STANICA_NE_RADI", label: "Stanica privremeno ne radi" },
  { code: "NIJE_MOGUCE_PRIPREMITI", label: "Nije moguće pripremiti" },
  { code: "DRUGO", label: "Drugo" },
];

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export function AvailabilityClient({ station, title }: { station: "KITCHEN" | "BAR"; title: string }) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [items, setItems] = useState<AvailabilityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<AvailabilityRow | null>(null);
  const [reasonCode, setReasonCode] = useState<string>("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      let loc = locationId;
      if (!loc) {
        const me = await apiFetch("/api/pos/me");
        loc = me.locationIds[0];
        setLocationId(loc);
      }
      const res = await apiFetch(`/api/production/availability?locationId=${loc}&station=${station}`);
      setItems(res.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station, locationId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  async function enable(item: AvailabilityRow) {
    if (!locationId) return;
    setBusyId(item.menuItemId);
    setError(null);
    try {
      await apiFetch("/api/production/availability", {
        method: "POST",
        body: JSON.stringify({ locationId, menuItemId: item.menuItemId, isAvailable: true }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    } finally {
      setBusyId(null);
    }
  }

  function openDisableModal(item: AvailabilityRow) {
    setDisableTarget(item);
    setReasonCode("");
    setNote("");
  }

  async function confirmDisable() {
    if (!locationId || !disableTarget || !reasonCode) return;
    setBusyId(disableTarget.menuItemId);
    setError(null);
    try {
      await apiFetch("/api/production/availability", {
        method: "POST",
        body: JSON.stringify({
          locationId,
          menuItemId: disableTarget.menuItemId,
          isAvailable: false,
          reasonCode,
          note: note.trim() || undefined,
        }),
      });
      setDisableTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška");
    } finally {
      setBusyId(null);
    }
  }

  const isBar = station === "BAR";
  const accentClass = isBar ? "text-sky-300/70" : "text-amber-300/70";
  const unavailableCount = items.filter((i) => !i.isAvailable).length;

  return (
    <div className={`min-h-screen p-3 sm:p-5 ${isBar ? "bg-[#071b2b]" : "bg-graphite-900"}`}>
      <div className="mb-5 flex items-center justify-between border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <AppLogo variant="mark" theme="dark" size="sm" />
          <div>
            <p className={`text-[10px] font-bold uppercase tracking-[.2em] ${accentClass}`}>TableCore · dostupnost</p>
            <h1 className="text-2xl font-bold tracking-tight text-cream-100">{title}</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {unavailableCount > 0 && (
            <span className="rounded-md border border-danger/30 bg-danger/15 px-3 py-2 text-xs font-semibold tabular-nums text-danger">
              {unavailableCount} nedostupno
            </span>
          )}
          <LogoutButton theme="dark" />
        </div>
      </div>

      {error && <div className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

      {loading ? (
        <div className="py-24 text-center text-cream-300/60">Učitavanje…</div>
      ) : items.length === 0 ? (
        <div className="py-24 text-center text-cream-300/60">Nema artikala za ovu stanicu.</div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <div
              key={item.menuItemId}
              className={`rounded-lg border p-3.5 ${
                item.isAvailable ? "border-white/[.06] bg-graphite-700" : "border-danger/40 bg-danger/10"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold text-cream-100">{item.name}</div>
                  {!item.isAvailable && (
                    <div className="mt-1 space-y-0.5">
                      <span className="inline-block rounded-full bg-danger px-2 py-0.5 text-[11px] font-bold text-white">NIJE DOSTUPNO</span>
                      <div className="text-xs text-danger/90">{item.reasonLabel}</div>
                      {item.note && <div className="text-xs italic text-cream-300/60">{item.note}</div>}
                      {item.updatedByName && (
                        <div className="text-[11px] text-cream-300/50">
                          {item.updatedByName}
                          {item.updatedAt ? ` · ${new Date(item.updatedAt).toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" })}` : ""}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <button
                type="button"
                disabled={busyId === item.menuItemId}
                onClick={() => (item.isAvailable ? openDisableModal(item) : enable(item))}
                className={`mt-3 min-h-11 w-full rounded-md py-2 text-sm font-bold transition-colors disabled:opacity-40 ${
                  item.isAvailable ? "bg-white/[.08] text-cream-100 hover:bg-danger/80" : "bg-success text-white hover:bg-success/90"
                }`}
              >
                {item.isAvailable ? "Označi nedostupnim" : "Ponovo dostupan"}
              </button>
            </div>
          ))}
        </div>
      )}

      {disableTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center" onClick={() => setDisableTarget(null)}>
          <div
            className="w-full max-w-sm rounded-lg bg-graphite-800 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-lg font-bold text-cream-100">Označi nedostupnim</h2>
            <p className="mb-4 text-sm text-cream-300/70">{disableTarget.name}</p>

            <div className="mb-3 space-y-1.5">
              {REASON_OPTIONS.map((r) => (
                <button
                  key={r.code}
                  type="button"
                  onClick={() => setReasonCode(r.code)}
                  className={`min-h-11 w-full rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors ${
                    reasonCode === r.code ? "border-danger bg-danger/20 text-danger" : "border-white/10 bg-white/[.04] text-cream-100 hover:bg-white/[.08]"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <label className="mb-1 block text-xs font-medium text-cream-300/70">Napomena (opciono)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="mb-4 w-full rounded-md border border-white/10 bg-white/[.04] px-3 py-2 text-sm text-cream-100 placeholder:text-cream-300/40"
              placeholder="Detalji (opciono)…"
            />

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDisableTarget(null)}
                className="min-h-11 rounded-md bg-white/[.08] text-sm font-semibold text-cream-100"
              >
                Otkaži
              </button>
              <button
                type="button"
                disabled={!reasonCode || busyId === disableTarget.menuItemId}
                onClick={confirmDisable}
                className="min-h-11 rounded-md bg-danger text-sm font-bold text-white disabled:opacity-40"
              >
                Potvrdi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
