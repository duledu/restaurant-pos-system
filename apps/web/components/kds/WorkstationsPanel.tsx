"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "../ui/Card";

interface Location {
  id: string;
  name: string;
}
interface Workstation {
  id: string;
  name: string;
  station: "KITCHEN" | "BAR";
  locationId: string;
  location: Location;
  configuredPrinterName: string | null;
  printerAvailable: boolean | null;
  paperWidthMm: number | null;
  agentVersion: string | null;
  osDescription: string | null;
  isEnabled: boolean;
  lastSeenAt: string | null;
  lastSuccessfulCommunicationAt: string | null;
  lastPrintAt: string | null;
  testPrintRequestedAt: string | null;
  testPrintStatus: "PENDING" | "SUCCEEDED" | "FAILED" | null;
  testPrintCompletedAt: string | null;
  testPrintError: string | null;
  revokedAt: string | null;
  pairedAt: string;
}
interface AgentDownloadInfo {
  available: boolean;
  url: string | null;
  version: string;
  supportedOS: string;
}
interface PendingPairing {
  id: string;
  station: "KITCHEN" | "BAR";
  name: string | null;
  locationId: string;
  location: Location;
  expiresAt: string;
  createdAt: string;
}

const STATION_LABEL: Record<"KITCHEN" | "BAR", string> = { KITCHEN: "Kuhinja", BAR: "Šank" };

// Radna stanica se smatra "povezanom" ako je poslala heartbeat u poslednja
// 2 minuta — namerno velikodušnije od HEARTBEAT_THROTTLE_MS na serveru
// (30s), da normalno kašnjenje između poziva ne prikazuje lažno "offline".
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("sr-RS", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS;
}

function remainingMinutes(expiresAt: string): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60000));
}

/**
 * Faza 2A — Admin foundation za TableCore Print Agent radne stanice.
 * NAMERNO restoran-šire (ne po-lokaciji kao PrinterConfig kartice iznad) —
 * jedan restoran može imati radne stanice na više lokacija; kreiranje
 * uparivanja koristi TRENUTNO izabranu lokaciju sa vrha stranice.
 *
 * Namerno jasno razdvojeno od QzSettingsPanel-a iznad/ispod (drugi
 * transport): QZ je po-browseru/po-računaru podešavanje (localStorage),
 * ovo je trajan, restoran-nivo identitet nezavisnog Windows procesa koji
 * server autentifikuje sopstvenim kredencijalom — ne kontrolišu ISTU
 * stanicu "automatski" istovremeno (KdsClient.tsx bira transport, QZ
 * ostaje jedini aktivan put dok Faza 2B ne uvede stvarnu dostavu tiketa
 * preko agenta).
 */
export function WorkstationsPanel({ locationId }: { locationId: string | null }) {
  const [workstationList, setWorkstationList] = useState<Workstation[]>([]);
  const [pendingPairings, setPendingPairings] = useState<PendingPairing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newStation, setNewStation] = useState<"KITCHEN" | "BAR">("KITCHEN");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreatedCode, setJustCreatedCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloadInfo, setDownloadInfo] = useState<AgentDownloadInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/workstations");
      setWorkstationList(res.workstations ?? []);
      setPendingPairings(res.pendingPairings ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju radnih stanica");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    apiFetch("/api/admin/workstations/agent-download")
      .then(setDownloadInfo)
      .catch(() => setDownloadInfo(null));
  }, []);

  async function testPrint(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/api/admin/workstations/${id}/test-print`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri zahtevu za test štampu");
    } finally {
      setBusyId(null);
    }
  }

  async function createPairing() {
    if (!locationId) return;
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/workstations/pairings", {
        method: "POST",
        body: JSON.stringify({ locationId, station: newStation, name: newName.trim() || undefined }),
      });
      setJustCreatedCode({ code: res.pairing.code, expiresAt: res.pairing.expiresAt });
      setNewName("");
      setShowAddForm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri kreiranju uparivanja");
    } finally {
      setCreating(false);
    }
  }

  async function cancelPairing(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/api/admin/workstations/pairings/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri otkazivanju");
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Opozvati ovu radnu stanicu? Agent će odmah izgubiti pristup i biće potrebno novo uparivanje.")) return;
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/api/admin/workstations/${id}/revoke`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri opozivu");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3">
        <h2 className="font-semibold text-ink">TableCore Print Agent — radne stanice</h2>
        <p className="mt-0.5 text-xs text-inkSoft">
          Nezavisan Windows proces sa sopstvenim kredencijalom po fizičkom računaru — nije vezan za pojedinačni
          browser/uređaj (za razliku od QZ podešavanja ispod). Trenutno samo identitet/status; stvarna dostava
          tiketa preko agenta dolazi u sledećoj fazi.
        </p>
      </div>

      <div className="mb-4 rounded-md border border-line px-3 py-2">
        <p className="text-xs font-semibold text-ink">TableCore Print Agent — instalacija</p>
        {downloadInfo?.available ? (
          <>
            <a
              href={downloadInfo.url ?? undefined}
              className="mt-1 inline-block text-xs font-semibold text-gold underline"
            >
              Preuzmi TableCore Print Agent (v{downloadInfo.version})
            </a>
            <p className="mt-0.5 text-xs text-inkSoft">Podržano: {downloadInfo.supportedOS}. Instaliraj, upari kodom sa gornje liste, izaberi štampač.</p>
          </>
        ) : (
          <p className="mt-1 text-xs text-inkSoft">
            Instaler još nije objavljen za preuzimanje sa ovog panela. Kontaktiraj TableCore administratora za
            {downloadInfo ? ` verziju ${downloadInfo.version}` : " instalacioni fajl"}.
          </p>
        )}
      </div>

      {error && <div className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}

      {justCreatedCode && (
        <div className="mb-4 rounded-md border border-gold/40 bg-gold-soft p-3">
          <p className="mb-1 text-xs font-semibold text-ink">Kod za uparivanje (unesi na Windows računaru)</p>
          <p className="font-mono text-lg font-bold tracking-wider text-ink">{justCreatedCode.code}</p>
          <p className="mt-1 text-xs text-inkSoft">
            Ističe za {remainingMinutes(justCreatedCode.expiresAt)} min — prikazuje se samo ovde, jednom. Sačuvaj ovaj ekran otvoren dok ne
            upariš agenta.
          </p>
          <button type="button" onClick={() => setJustCreatedCode(null)} className="mt-2 text-xs font-semibold text-inkSoft underline">
            Zatvori
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-inkSoft">Učitavanje…</p>
      ) : (
        <>
          {pendingPairings.length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-xs font-semibold text-inkSoft">Uparivanja na čekanju</p>
              <div className="space-y-2">
                {pendingPairings.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm">
                    <div>
                      <span className="font-medium text-ink">{p.name || STATION_LABEL[p.station]}</span>
                      <span className="ml-2 text-xs text-inkSoft">
                        {STATION_LABEL[p.station]} · {p.location.name} · ističe za {remainingMinutes(p.expiresAt)} min
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => cancelPairing(p.id)}
                      disabled={busyId === p.id}
                      className="text-xs font-semibold text-danger disabled:opacity-40"
                    >
                      Otkaži
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {workstationList.length > 0 && (
            <div className="mb-4 space-y-2">
              {workstationList.map((w) => {
                const online = isOnline(w.lastSeenAt);
                const revoked = Boolean(w.revokedAt);
                // "Tiha štampa spremna" — sve mora biti tačno: omogućena,
                // neopozvana, nedavno javljena, ima konfigurisan štampač I
                // agent je taj tačan štampač poslednji put video u Windows
                // spisku (nikad pretpostavljeno kad printerAvailable === null,
                // tj. agent to još nije prijavio).
                const silentPrintReady = !revoked && w.isEnabled && online && Boolean(w.configuredPrinterName) && w.printerAvailable === true;
                return (
                  <div key={w.id} className="rounded-md border border-line px-3 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium text-ink">{w.name}</span>
                        <span className="ml-2 text-xs text-inkSoft">
                          {STATION_LABEL[w.station]} · {w.location.name}
                        </span>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          revoked
                            ? "bg-danger-soft text-danger"
                            : !w.isEnabled
                              ? "bg-cream-200 text-inkSoft"
                              : online
                                ? "bg-success/10 text-success"
                                : "bg-cream-200 text-inkSoft"
                        }`}
                      >
                        {revoked ? "Opozvana" : !w.isEnabled ? "Onemogućena" : online ? "Povezana" : "Van mreže"}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-inkSoft">
                      <span>Štampač: {w.configuredPrinterName ?? "nije prijavljen"}</span>
                      {w.configuredPrinterName && w.printerAvailable === false && (
                        <span className="font-semibold text-danger">Štampač nije dostupan na računaru</span>
                      )}
                      <span className={silentPrintReady ? "font-semibold text-success" : ""}>
                        {silentPrintReady ? "Tiha štampa spremna" : "Tiha štampa nije spremna"}
                      </span>
                      <span>Verzija agenta: {w.agentVersion ?? "—"}</span>
                      <span>Poslednji kontakt: {formatDateTime(w.lastSeenAt)}</span>
                      <span>Poslednja uspešna komunikacija: {formatDateTime(w.lastSuccessfulCommunicationAt)}</span>
                      <span>Poslednja predaja na štampu: {formatDateTime(w.lastPrintAt)}</span>
                      {w.testPrintStatus === "PENDING" && (
                        <span className="font-semibold text-inkSoft">Test štampa: čeka se sledeći kontakt agenta…</span>
                      )}
                      {w.testPrintStatus === "SUCCEEDED" && (
                        <span className="font-semibold text-success">Test štampa uspela ({formatDateTime(w.testPrintCompletedAt)})</span>
                      )}
                      {w.testPrintStatus === "FAILED" && (
                        <span className="font-semibold text-danger">
                          Test štampa nije uspela ({formatDateTime(w.testPrintCompletedAt)}){w.testPrintError ? `: ${w.testPrintError}` : ""}
                        </span>
                      )}
                    </div>
                    {!revoked && (
                      <div className="mt-2 flex gap-3">
                        <button
                          type="button"
                          onClick={() => testPrint(w.id)}
                          disabled={busyId === w.id || w.testPrintStatus === "PENDING"}
                          className="text-xs font-semibold text-ink underline disabled:opacity-40"
                        >
                          Test Print
                        </button>
                        <button
                          type="button"
                          onClick={() => revoke(w.id)}
                          disabled={busyId === w.id}
                          className="text-xs font-semibold text-danger disabled:opacity-40"
                        >
                          Opozovi
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {workstationList.length === 0 && pendingPairings.length === 0 && (
            <p className="mb-4 text-sm text-inkSoft">Nijedna radna stanica još nije uparena.</p>
          )}

          {showAddForm ? (
            <div className="rounded-md border border-line p-3">
              <div className="mb-3 flex flex-wrap gap-3">
                <div>
                  <label className="mb-1 block text-xs text-inkSoft">Stanica</label>
                  <select
                    value={newStation}
                    onChange={(e) => setNewStation(e.target.value as "KITCHEN" | "BAR")}
                    className="rounded-md border border-line px-3 py-2 text-sm text-ink"
                  >
                    <option value="KITCHEN">Kuhinja</option>
                    <option value="BAR">Šank</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-xs text-inkSoft">Naziv (opciono)</label>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="npr. Kuhinjski računar"
                    className="w-full rounded-md border border-line px-3 py-2 text-sm text-ink"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={createPairing}
                  disabled={creating || !locationId}
                  className="min-h-11 rounded-md bg-graphite px-4 text-sm font-semibold text-cream-100 disabled:opacity-40"
                >
                  {creating ? "Kreiranje…" : "Generiši kod za uparivanje"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="min-h-11 rounded-md border border-line px-4 text-sm font-semibold text-inkSoft"
                >
                  Otkaži
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              disabled={!locationId}
              className="min-h-11 rounded-md border border-line px-5 py-2 text-sm font-semibold text-inkSoft hover:border-gold/50 hover:text-ink disabled:opacity-40"
            >
              + Dodaj radnu stanicu
            </button>
          )}
        </>
      )}
    </Card>
  );
}
