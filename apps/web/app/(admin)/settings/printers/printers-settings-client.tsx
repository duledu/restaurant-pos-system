"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "../../../../components/ui/Card";
import { Skeleton } from "../../../../components/ui/Skeleton";

interface Location {
  id: string;
  name: string;
}
interface PrinterConfig {
  id: string;
  locationId: string;
  station: "KITCHEN" | "BAR" | "RECEIPT";
  name: string;
  printerType: "BROWSER" | "ESC_POS_LAN" | "NETWORK";
  paperWidthMm: number;
  isEnabled: boolean;
  autoPrint: boolean;
  copies: number;
}

const STATIONS: { value: PrinterConfig["station"]; label: string }[] = [
  { value: "KITCHEN", label: "Kuhinja" },
  { value: "BAR", label: "Šank" },
  { value: "RECEIPT", label: "Račun" },
];

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function emptyDraft(locationId: string, station: PrinterConfig["station"]): Omit<PrinterConfig, "id"> {
  return { locationId, station, name: "", printerType: "BROWSER", paperWidthMm: 80, isEnabled: true, autoPrint: false, copies: 1 };
}

export function PrintersSettingsClient() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [printers, setPrinters] = useState<PrinterConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const locRes = await apiFetch("/api/admin/locations");
      const locs: Location[] = locRes.locations ?? [];
      setLocations(locs);
      const loc = locationId ?? locs[0]?.id ?? null;
      setLocationId(loc);
      if (loc) {
        const printersRes = await apiFetch(`/api/admin/settings/printers?locationId=${loc}`);
        setPrinters(printersRes.printers ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function configFor(station: PrinterConfig["station"]): Omit<PrinterConfig, "id"> | PrinterConfig {
    return printers.find((p) => p.station === station) ?? emptyDraft(locationId ?? "", station);
  }

  async function save(config: Omit<PrinterConfig, "id"> | PrinterConfig) {
    if (!locationId) return;
    setSaving(config.station);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/settings/printers", { method: "POST", body: JSON.stringify(config) });
      setPrinters((prev) => {
        const next = prev.filter((p) => p.station !== config.station);
        return [...next, res.printer];
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri čuvanju");
    } finally {
      setSaving(null);
    }
  }

  function updateDraft(station: PrinterConfig["station"], patch: Partial<PrinterConfig>) {
    setPrinters((prev) => {
      const existing = prev.find((p) => p.station === station);
      const base = existing ?? { ...emptyDraft(locationId ?? "", station), id: "" };
      const updated = { ...base, ...patch };
      const next = prev.filter((p) => p.station !== station);
      return [...next, updated as PrinterConfig];
    });
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Podešavanja štampača</h1>
          <p className="mt-1 text-sm text-inkSoft">Kuhinjski, šank i računski štampač po lokaciji</p>
        </div>
        {locations.length > 1 && (
          <select
            value={locationId ?? ""}
            onChange={(e) => setLocationId(e.target.value)}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink"
          >
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>{loc.name}</option>
            ))}
          </select>
        )}
      </div>

      {error && <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      {loading ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="space-y-4">
          {STATIONS.map(({ value: station, label }) => {
            const cfg = configFor(station);
            return (
              <Card key={station} className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="font-semibold text-ink">{label} — štampač</h2>
                  <label className="flex items-center gap-2 text-sm text-inkSoft">
                    <input
                      type="checkbox"
                      checked={cfg.isEnabled}
                      onChange={(e) => updateDraft(station, { isEnabled: e.target.checked })}
                    />
                    Omogućen
                  </label>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-inkSoft">Naziv</label>
                    <input
                      value={cfg.name}
                      onChange={(e) => updateDraft(station, { name: e.target.value })}
                      className="w-full rounded-md border border-line px-3 py-2 text-sm text-ink"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-inkSoft">Širina papira (mm)</label>
                    <select
                      value={cfg.paperWidthMm}
                      onChange={(e) => updateDraft(station, { paperWidthMm: Number(e.target.value) })}
                      className="w-full rounded-md border border-line px-3 py-2 text-sm text-ink"
                    >
                      <option value={80}>80mm</option>
                      <option value={58}>58mm</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-inkSoft">Tip štampača</label>
                    <select
                      value={cfg.printerType}
                      onChange={(e) => updateDraft(station, { printerType: e.target.value as PrinterConfig["printerType"] })}
                      className="w-full rounded-md border border-line px-3 py-2 text-sm text-ink"
                    >
                      <option value="BROWSER">Browser (podrazumevano)</option>
                      <option value="ESC_POS_LAN" disabled>ESC/POS mrežni (uskoro)</option>
                      <option value="NETWORK" disabled>Mrežni (uskoro)</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-inkSoft">Broj kopija</label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={cfg.copies}
                      onChange={(e) => updateDraft(station, { copies: Number(e.target.value) })}
                      className="w-full rounded-md border border-line px-3 py-2 text-sm text-ink"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="flex items-center gap-2 text-sm text-inkSoft">
                      <input
                        type="checkbox"
                        checked={cfg.autoPrint}
                        onChange={(e) => updateDraft(station, { autoPrint: e.target.checked })}
                      />
                      Automatska štampa (kad podrška za server-side adapter bude dostupna)
                    </label>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => save(cfg)}
                  disabled={saving === station || !cfg.name}
                  className="mt-4 min-h-11 rounded-md bg-graphite px-5 py-2 text-sm font-semibold text-cream-100 disabled:opacity-40"
                >
                  {saving === station ? "Čuvanje…" : "Sačuvaj"}
                </button>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
