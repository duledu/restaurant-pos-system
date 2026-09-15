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
 * NAMERNO restoran-šire (ne po-lokaciji kao legacy PrinterConfig kartice,
 * sada sklonjene ispod u "Napredno / rezervni način štampe") — jedan
 * restoran može imati radne stanice na više lokacija; kreiranje uparivanja
 * koristi TRENUTNO izabranu lokaciju sa vrha stranice.
 *
 * Namerno jasno razdvojeno od QzSettingsPanel-a (drugi transport, sada
 * takođe u "Napredno"): QZ je po-browseru/po-računaru podešavanje
 * (localStorage), ovo je trajan, restoran-nivo identitet nezavisnog
 * Windows procesa koji server autentifikuje sopstvenim kredencijalom — ne
 * kontrolišu ISTU stanicu "automatski" istovremeno (KdsClient.tsx bira
 * transport; kad je ovaj agent aktivan za stanicu, on je jedini automatski
 * put — QZ/legacy ostaje samo rezervni/ručni, vidi print-policy.ts
 * activeWorkstationFor).
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);
  const [codeCopied, setCodeCopied] = useState(false);

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

  function startEditing(w: Workstation) {
    setEditingId(w.id);
    setEditName(w.name);
    setEditEnabled(w.isEnabled);
  }

  async function saveEditing(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/api/admin/workstations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName.trim() || undefined, isEnabled: editEnabled }),
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri čuvanju podešavanja");
    } finally {
      setBusyId(null);
    }
  }

  // "Ponovo upari" ne dira postojeći red (agent zadržava stari kredencijal
  // dok se ne opozove) — samo unapred popunjava formu za NOVO uparivanje
  // istim nazivom/stanicom, korisno kad se agent ponovo instalira na istom
  // ili zamenskom računaru.
  function rePair(w: Workstation) {
    setNewStation(w.station);
    setNewName(w.name);
    setShowAddForm(true);
    setJustCreatedCode(null);
  }

  async function copyPairingCode(code: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        // Sigurnosna rezerva za browsere/kontekste bez Clipboard API-ja
        // (stariji mobilni browseri, neki in-app webview-ovi, ne-HTTPS
        // lokalni razvoj) — klasičan textarea+execCommand pristup, i dalje
        // širko podržan iako "zastareo". Nikad ne menja/ponovo generiše kod.
        const textarea = document.createElement("textarea");
        textarea.value = code;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.top = "0";
        textarea.style.left = "0";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, code.length);
        document.execCommand("copy");
        textarea.remove();
      }
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      // I Clipboard API i execCommand rezerva mogu da ne uspeju (dozvole,
      // sandboxed iframe) — kod ostaje čitljiv i selektovan tekstom na
      // ekranu, ručno kopiranje i dalje radi, samo bez potvrde "Kopirano".
    }
  }

  // Napredak koraka 1-6 je namerno IZVEDEN iz stvarnog stanja (workstation
  // lista/pending uparivanja/downloadInfo) — nikad ručno postavljen checkbox
  // koji bi mogao lagati administratora o tome šta je stvarno urađeno.
  const activeWorkstations = workstationList.filter((w) => !w.revokedAt);
  const anyPrinterConfigured = activeWorkstations.some((w) => Boolean(w.configuredPrinterName));
  const anyTestSucceeded = activeWorkstations.some((w) => w.testPrintStatus === "SUCCEEDED");
  const anyReady = activeWorkstations.some(
    (w) => w.isEnabled && Boolean(w.configuredPrinterName) && w.printerAvailable === true
  );
  const setupSteps = [
    { label: "Preuzmi Print Agent", done: Boolean(downloadInfo?.available) },
    { label: "Dodaj računar", done: activeWorkstations.length > 0 || pendingPairings.length > 0 },
    { label: "Upari", done: activeWorkstations.length > 0 },
    { label: "Izaberi štampač", done: anyPrinterConfigured },
    { label: "Test štampa", done: anyTestSucceeded },
    { label: "Spremno", done: anyReady },
  ];

  // Problem 1/7 ispravka — aktivne radne stanice grupisane po NAMENI
  // (Kuhinja/Šank), jasno odvojene od istorijskih/opozvanih redova, da
  // Admin stranica liči na "fizička odredišta štampe po stanici" umesto
  // na plosnatu listu svih redova ikad uparenih. Opozvane stanice ostaju u
  // bazi (istorija/audit) ali se sklanjaju u sažetu sekciju ispod da se
  // vizuelno ne mešaju sa stvarnim rutiranjem.
  const revokedWorkstations = workstationList.filter((w) => w.revokedAt);
  const stationGroups: { station: "KITCHEN" | "BAR"; label: string }[] = [
    { station: "KITCHEN", label: "Kuhinja" },
    { station: "BAR", label: "Šank" },
  ];

  function renderWorkstationCard(w: Workstation) {
    const online = isOnline(w.lastSeenAt);
    const revoked = Boolean(w.revokedAt);
    // "Automatska štampa" — sve mora biti tačno: omogućena, neopozvana,
    // nedavno javljena, ima konfigurisan štampač I agent je taj tačan
    // štampač poslednji put video u Windows spisku (nikad pretpostavljeno
    // kad printerAvailable === null, tj. agent to još nije prijavio).
    // Part 13 hardening — PROVERENO identično (isti uslovi, isti 2-minutni
    // prag) sa agentPrinting.stationPrinterStatus-ovim READY stanjem koje
    // KDS prikazuje (agent-print-service.ts) — namerno NIJE pozvana ista
    // funkcija ovde jer ona vraća JEDNO agregatno stanje po STANICI, dok
    // ova kartica prikazuje SVAKU radnu stanicu pojedinačno; ako se ijedan
    // uslov ikad promeni, MORA se promeniti na oba mesta da Admin i KDS
    // nikad ne prikažu suprotstavljene odgovore za isti server podatak.
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
          <span>Širina papira: {w.paperWidthMm ? `${w.paperWidthMm}mm` : "nije prijavljena"}</span>
          <span className={silentPrintReady ? "font-semibold text-success" : ""}>
            Automatska štampa: {silentPrintReady ? "Spremna" : "Nije spremna"}
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
        {editingId === w.id ? (
          <div className="mt-2 rounded-md border border-line bg-cream-100 p-2.5">
            <label className="mb-1 block text-xs text-inkSoft" htmlFor={`ws-name-${w.id}`}>Naziv</label>
            <input
              id={`ws-name-${w.id}`}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="mb-2 w-full rounded-md border border-line px-3 py-1.5 text-sm text-ink"
            />
            <label className="mb-2 flex items-center gap-2 text-xs text-inkSoft">
              <input type="checkbox" checked={editEnabled} onChange={(e) => setEditEnabled(e.target.checked)} />
              Omogućena (isključi da privremeno zaustaviš automatsku štampu bez opoziva)
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => saveEditing(w.id)}
                disabled={busyId === w.id || !editName.trim()}
                className="min-h-9 rounded-md bg-graphite px-3 text-xs font-semibold text-cream-100 disabled:opacity-40"
              >
                Sačuvaj
              </button>
              <button
                type="button"
                onClick={() => setEditingId(null)}
                className="min-h-9 rounded-md border border-line px-3 text-xs font-semibold text-inkSoft"
              >
                Otkaži
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-3">
            {!revoked && (
              <>
                <button
                  type="button"
                  onClick={() => testPrint(w.id)}
                  disabled={busyId === w.id || w.testPrintStatus === "PENDING"}
                  className="text-xs font-semibold text-ink underline disabled:opacity-40"
                >
                  Test štampa
                </button>
                <button
                  type="button"
                  onClick={() => startEditing(w)}
                  disabled={busyId === w.id}
                  className="text-xs font-semibold text-ink underline disabled:opacity-40"
                >
                  Podešavanja
                </button>
              </>
            )}
            <button type="button" onClick={() => rePair(w)} className="text-xs font-semibold text-inkSoft underline">
              Ponovo upari
            </button>
            {!revoked && (
              <button
                type="button"
                onClick={() => revoke(w.id)}
                disabled={busyId === w.id}
                className="text-xs font-semibold text-danger disabled:opacity-40"
              >
                Opozovi
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <Card className="p-5">
      <div className="mb-3">
        <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-gold-soft px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gold-dark">
          Preporučen metod
        </div>
        <h2 className="font-semibold text-ink">TableCore Print Agent</h2>
        <p className="mt-0.5 text-xs text-inkSoft">
          Omogućava tihu, automatsku štampu na kuhinjskom/šank računaru — bez otvaranja browsera, bez Chrome
          dijaloga za štampu i bez ručnog odobrenja po tiketu. Kad je računar uparen i ima izabran štampač, ta
          stanica (Kuhinja/Šank) automatski prima i štampa svaki novi tiket.
        </p>
      </div>

      <ol className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
        {setupSteps.map((step, i) => (
          <li
            key={step.label}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-semibold ${
              step.done ? "border-success/30 bg-success/10 text-success" : "border-line text-inkSoft"
            }`}
          >
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                step.done ? "bg-success text-cream-100" : "bg-cream-200 text-inkSoft"
              }`}
            >
              {step.done ? "✓" : i + 1}
            </span>
            {step.label}
          </li>
        ))}
      </ol>

      <div className="mb-4 rounded-md border border-line px-3 py-3">
        <p className="mb-1 text-xs font-semibold text-ink">1. Preuzmi Print Agent</p>
        {downloadInfo?.available ? (
          <>
            <a
              href={downloadInfo.url ?? undefined}
              className="inline-block min-h-11 rounded-md bg-graphite px-5 py-2.5 text-sm font-semibold text-cream-100"
            >
              Preuzmi Print Agent za Windows
            </a>
            <p className="mt-1.5 text-xs text-inkSoft">
              Verzija {downloadInfo.version} · {downloadInfo.supportedOS}. Pokreni preuzeti fajl na kuhinjskom/šank
              računaru, prati podešavanje, pa unesi kod za uparivanje sa liste ispod.
            </p>
          </>
        ) : (
          <p className="text-xs text-inkSoft">
            Instaler još nije objavljen za preuzimanje sa ovog panela. Kontaktiraj TableCore administratora za
            {downloadInfo ? ` verziju ${downloadInfo.version}` : " instalacioni fajl"}.
          </p>
        )}
      </div>

      {error && <div className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}

      {justCreatedCode && (
        <div className="mb-4 rounded-md border border-gold/40 bg-gold-soft p-3">
          <p className="mb-1 text-xs font-semibold text-ink">Kod za uparivanje (unesi na Windows računaru)</p>
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-mono text-2xl font-bold tracking-wider text-ink">{justCreatedCode.code}</p>
            <button
              type="button"
              onClick={() => copyPairingCode(justCreatedCode.code)}
              className="min-h-9 rounded-md border border-gold/50 bg-cream-100 px-3 text-xs font-semibold text-ink hover:bg-gold-soft"
            >
              {codeCopied ? "✓ Kopirano" : "Kopiraj kod"}
            </button>
          </div>
          <p className="mt-1 text-xs text-inkSoft">
            Ističe za {remainingMinutes(justCreatedCode.expiresAt)} min — prikazuje se samo ovde, jednom. Sačuvaj ovaj ekran otvoren dok ne
            upariš agenta.
          </p>
          <button
            type="button"
            onClick={() => {
              setJustCreatedCode(null);
              setCodeCopied(false);
            }}
            className="mt-2 text-xs font-semibold text-inkSoft underline"
          >
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

          <div className="mb-4 space-y-4">
            {stationGroups.map(({ station, label }) => {
              const stationWorkstations = activeWorkstations.filter((w) => w.station === station);
              return (
                <div key={station}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-inkSoft">{label}</p>
                  {stationWorkstations.length > 0 ? (
                    <div className="space-y-2">{stationWorkstations.map(renderWorkstationCard)}</div>
                  ) : (
                    <p className="rounded-md border border-dashed border-line px-3 py-2 text-xs text-inkSoft">
                      Nijedan računar nije uparen za {label.toLowerCase()}u.
                    </p>
                  )}
                </div>
              );
            })}
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-inkSoft">Računi / POS</p>
              <p className="rounded-md border border-dashed border-line px-3 py-2 text-xs text-inkSoft">
                Uskoro — štampa računa preko Print Agent-a još nije dostupna. Koristi rezervni metod ispod (Napredno) za sada.
              </p>
            </div>
          </div>

          {revokedWorkstations.length > 0 && (
            <details className="mb-4 rounded-md border border-line">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-inkSoft">
                Neaktivne / opozvane stanice ({revokedWorkstations.length})
              </summary>
              <div className="space-y-2 border-t border-line p-3">{revokedWorkstations.map(renderWorkstationCard)}</div>
            </details>
          )}

          {showAddForm ? (
            <div className="rounded-md border border-line p-3">
              <div className="mb-3 flex flex-wrap gap-3">
                <div>
                  <label className="mb-1 block text-xs text-inkSoft">Namena</label>
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
              + Dodaj računar
            </button>
          )}
        </>
      )}
    </Card>
  );
}
