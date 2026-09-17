"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "../ui/Card";

interface Location {
  id: string;
  name: string;
}
type RouteType = "KITCHEN" | "BAR" | "RECEIPT";
interface PrintRoute {
  id: string;
  type: RouteType;
  printerName: string | null;
  paperWidthMm: number | null;
  printerAvailable: boolean | null;
  // PRINTING P0 — operator-pressed "Da, test tiket je uspešno odštampan"
  // on the Setup wizard (or Admin equivalent) for this exact
  // (printerName, paperWidthMm) combination. FALSE means the printer
  // hasn't been physically confirmed yet — Admin surfaces this as a
  // clear "needs confirmation" pill on each route row, and the Admin
  // "Test Print" button now drives both the technical test AND the
  // human confirmation in a single flow.
  physicalTestConfirmed: boolean;
  physicalTestConfirmedAt: string | null;
  // PRINTING P0 — Service-side visibility probe. NULL = "not yet
  // probed" (the very first heartbeat after route configuration).
  // FALSE = "the running Agent SERVICE cannot see this printer" —
  // the most common per-user-vs-per-machine driver install failure
  // mode. Surfaces as a dedicated warning that names the failure and
  // the actionable fix without exposing infrastructure terminology.
  visibleToService: boolean | null;
  visibleToServiceAt: string | null;
  isEnabled: boolean;
  isPrimary: boolean;
  updatedAt: string;
}
// PRINTING V2 FINAL — LOGIN_AWARE only; always null under CENTRAL_ROUTING.
interface TerminalSession {
  printRole: RouteType;
  employeeId: string;
  expiresAt: string;
}
interface Workstation {
  id: string;
  name: string;
  locationId: string;
  location: Location;
  availablePrinters: string[] | null;
  printersReportedAt: string | null;
  printRoutes: PrintRoute[];
  terminalSession: TerminalSession | null;
  agentVersion: string | null;
  osDescription: string | null;
  isEnabled: boolean;
  lastSeenAt: string | null;
  lastSuccessfulCommunicationAt: string | null;
  lastPrintAt: string | null;
  testPrintRequestedAt: string | null;
  testPrintRouteType: RouteType | null;
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
  name: string | null;
  locationId: string;
  location: Location;
  expiresAt: string;
  createdAt: string;
}
interface RouteDraft {
  printerName: string;
  paperWidthMm: 58 | 80;
  isEnabled: boolean;
  isPrimary: boolean;
}
type PrintingMode = "LOGIN_AWARE" | "CENTRAL_ROUTING";
const PRINTING_MODE_LABEL: Record<PrintingMode, string> = { LOGIN_AWARE: "Prema prijavljenom korisniku", CENTRAL_ROUTING: "Centralno rutiranje" };

const ROUTE_TYPES: RouteType[] = ["KITCHEN", "BAR", "RECEIPT"];
const ROUTE_LABEL: Record<RouteType, string> = { KITCHEN: "Kuhinja", BAR: "Šank", RECEIPT: "Račun" };

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

function routeOf(w: Workstation, type: RouteType): PrintRoute | undefined {
  return w.printRoutes.find((r) => r.type === type);
}

/** Ista diskriminovana logika kao agentPrinting.stationPrinterStatus
 * (packages/domain/printing/agent-print-service.ts) — namerno DUPLIRANA
 * ovde umesto pozvana preko API-ja jer ova kartica prikazuje SVAKU rutu
 * pojedinačno iz podataka koje /api/admin/workstations već vratio, bez
 * dodatnog upita po ruti. Ako se ijedan uslov ikad promeni, MORA se
 * promeniti na oba mesta da Admin i KDS nikad ne prikažu suprotstavljene
 * odgovore za isti server podatak.
 *
 * PRINTING P0 — adds two new states:
 *   AGENT_CANNOT_SEE — Service identity cannot enumerate this route's
 *     printer (visibleToService === false on the route). Distinct from
 *     PRINTER_UNAVAILABLE (which is the printerAvailable === false
 *     post-attempt signal). Triggers a dedicated human-friendly
 *     "TableCore servis ne može da pristupi štampaču" banner.
 *   NEEDS_CONFIRMATION — printer is configured and visible to the
 *     Service, but the operator has not yet pressed "Da, test tiket
 *     je uspešno odštampan" on the Setup wizard for this exact
 *     (printerName, paperWidthMm) combination. The Admin "Test Print"
 *     button drives both the technical test AND the human confirmation
 *     in a single flow.
 * The legacy "READY" state is now STRICTLY the conjunction of:
 *   isEnabled + printerName + paperWidthMm + isOnline + printerReady +
 *   visibleToService (true) + physicalTestConfirmed (true).
 * Any silent weakening of that conjunction here would defeat the entire
 * P0 fix; see SETUP-form OnSave for the matching wizard-side check.
 */
function routeReadiness(
  w: Workstation,
  route: PrintRoute | undefined
): "READY" | "AGENT_OFFLINE" | "PRINTER_UNAVAILABLE" | "NOT_CONFIGURED" | "AGENT_CANNOT_SEE" | "NEEDS_CONFIRMATION" {
  if (!route || !route.isEnabled || w.revokedAt || !w.isEnabled) return "NOT_CONFIGURED";
  if (!isOnline(w.lastSeenAt)) return "AGENT_OFFLINE";
  // Service-side visibility probe — distinct from post-attempt
  // printerAvailable, evaluated before we trust any "Test Print"
  // output the operator might already have on the table.
  if (route.visibleToService === false) return "AGENT_CANNOT_SEE";
  // False-"Štampač nedostupan" root cause (Part B, mirrors
  // agent-print-service.ts stationPrinterStatus) — printerAvailable===false
  // is a proven signal, trust it. printerAvailable===null only means "not
  // yet reconfirmed since the route was last saved" (every route save nulls
  // it, even a same-value resave of an unrelated field); fall back to the
  // workstation's latest availablePrinters (refreshed on every heartbeat,
  // never reset by a route save) instead of showing a false negative.
  const listedAsAvailable = route.printerName != null && (w.availablePrinters?.includes(route.printerName) ?? false);
  const printerReady = route.printerAvailable === true || (route.printerAvailable === null && listedAsAvailable);
  if (!route.printerName || !printerReady) return "PRINTER_UNAVAILABLE";
  if (!route.physicalTestConfirmed) return "NEEDS_CONFIRMATION";
  return "READY";
}

const READINESS_LABEL: Record<ReturnType<typeof routeReadiness>, string> = {
  READY: "Spremna",
  AGENT_OFFLINE: "Računar nije povezan",
  PRINTER_UNAVAILABLE: "Štampač nedostupan",
  NOT_CONFIGURED: "Nije podešeno",
  AGENT_CANNOT_SEE: "Servis ne vidi štampač",
  NEEDS_CONFIRMATION: "Čeka fizičku potvrdu",
};

/**
 * Printing V2 — Admin foundation za TableCore Print Agent računare.
 * NAMERNO restoran-šire (ne po-lokaciji kao legacy PrinterConfig kartice,
 * sada sklonjene ispod u "Napredno / rezervni način štampe") — jedan
 * restoran može imati računare na više lokacija; kreiranje uparivanja
 * koristi TRENUTNO izabranu lokaciju sa vrha stranice.
 *
 * Konceptualni model od ove verzije nadalje: uparivanje uspostavlja SAMO
 * identitet računara (nikad "ovaj računar je Kuhinja/Šank") — rute štampe
 * (Kuhinja/Šank/Račun, svaka sa sopstvenim štampačem/širinom papira) se
 * biraju POSLE, ovde ispod, i isti fizički štampač sme da posluži više
 * ruta odjednom. Promena jedne rute nikad ne zahteva novo uparivanje.
 *
 * Namerno jasno razdvojeno od QzSettingsPanel-a (drugi transport, sada
 * takođe u "Napredno"): QZ je po-browseru/po-računaru podešavanje
 * (localStorage), ovo je trajan, restoran-nivo identitet nezavisnog
 * Windows procesa koji server autentifikuje sopstvenim kredencijalom — ne
 * kontrolišu ISTU rutu "automatski" istovremeno (KdsClient.tsx bira
 * transport; kad je ovaj agent aktivan za rutu, on je jedini automatski
 * put — QZ/legacy ostaje samo rezervni/ručni, vidi print-policy.ts
 * activeWorkstationFor).
 */
export function WorkstationsPanel({ locationId }: { locationId: string | null }) {
  const [workstationList, setWorkstationList] = useState<Workstation[]>([]);
  const [pendingPairings, setPendingPairings] = useState<PendingPairing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreatedCode, setJustCreatedCode] = useState<{ pairingId: string; code: string; expiresAt: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloadInfo, setDownloadInfo] = useState<AgentDownloadInfo | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);
  const [codeCopied, setCodeCopied] = useState(false);
  const [routeDrafts, setRouteDrafts] = useState<Record<string, RouteDraft>>({});
  const [savingRoutesId, setSavingRoutesId] = useState<string | null>(null);
  const [testingRoute, setTestingRoute] = useState<string | null>(null);
  const [printingMode, setPrintingModeState] = useState<PrintingMode>("CENTRAL_ROUTING");
  const [savingMode, setSavingMode] = useState(false);
  // PRINTING P0 — operator reconciliation surface. The list is populated
  // by the load() poll (filtered to SUBMISSION_UNKNOWN jobs in the
  // current shift) so the Admin sees a dedicated banner with
  // per-job CONFIRM PRINTED / REPRINT buttons. Each action POSTs to
  // /api/admin/print-jobs/{id}/acknowledge-ambiguity with the
  // operator's decision; the server handles audit + state transition.
  const [ambiguityJobs, setAmbiguityJobs] = useState<AmbiguityJob[]>([]);
  const [resolvingJobId, setResolvingJobId] = useState<string | null>(null);

  interface AmbiguityJob {
    id: string;
    type: "KITCHEN" | "BAR" | "RECEIPT";
    orderId: string;
    createdAt: string;
    failureReason: string | null;
  }

  // PREPROD physical QA follow-up (Part A2) — ranije se ovo učitavalo TAČNO
  // JEDNOM pri montiranju, pa je Admin morao da se ručno F5-uje da vidi
  // uparivanje/online-offline/promenu štampača/heartbeat/opoziv itd. SSE
  // infrastruktura POSTOJI (realtime/sse-publisher.ts) ali je sopstvenom
  // dokumentacijom označena kao NEPOUZDANA na Vercel Serverless Functions u
  // produkciji (in-memory EventEmitter ne deli memoriju između invokacija —
  // publish sa jedne instance ne stiže do SSE konekcije na drugoj, "garancija
  // ne postoji na serverless platformi"). Umesto da se oslonimo na tu
  // nepouzdanu putanju, ovo koristi ISTI, već dokazan obrazac kao
  // KdsClient.tsx: lagan `setInterval` poll + in-flight brava (bez preklapanja)
  // — jedan jeftin GET na postojeću rutu, bez ijedne nove zavisnosti.
  const loadInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setError(null);
    try {
      const res = await apiFetch("/api/admin/workstations");
      setWorkstationList(res.workstations ?? []);
      const pending: PendingPairing[] = res.pendingPairings ?? [];
      setPendingPairings(pending);
      if (res.printingMode === "LOGIN_AWARE" || res.printingMode === "CENTRAL_ROUTING") setPrintingModeState(res.printingMode);
      // Printing V2 — auto-resolve the "just created" code panel the
      // instant its pairing is no longer PENDING (consumed by a
      // successful Agent pairing, cancelled, or naturally expired) — no
      // page refresh or manual dismissal needed; the newly connected
      // computer already appears in workstationList from this SAME poll.
      setJustCreatedCode((prev) => (prev && !pending.some((p) => p.id === prev.pairingId) ? null : prev));
      // PRINTING P0 — refresh the SUBMISSION_UNKNOWN reconciliation
      // banner. Fetched in parallel via a non-blocking call so a
      // transient failure here does not delay the main workstation list.
      // Errors are intentionally swallowed into console — the banner
      // only hides if the endpoint is down, and the next poll re-tries.
      apiFetch("/api/admin/print-jobs/submission-unknown")
        .then((r) => setAmbiguityJobs(r.jobs ?? []))
        .catch(() => {/* noop; banner quietly hides until next successful poll */});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri učitavanju radnih stanica");
    } finally {
      setLoading(false);
      loadInFlightRef.current = false;
    }
  }, []);

  // PRINTING P0 — operator reconciliation actions on a
  // SUBMISSION_UNKNOWN PrintJob. `decision` mirrors the server schema
  // ("PRINTED" | "REPRINT"); the server is the single source of truth
  // for the resulting state transition and audit entry. UI just sends
  // the decision and refreshes the list.
  //
  // DOUBLE-CLICK PROTECTION — without server-side idempotency, an
  // operator who clicks "Pošalji ponovo" twice (slow network, stuck
  // modal, browser retry) would create TWO child PrintJobs and the
  // physical printer would emit TWO tickets. We pass a STABLE
  // idempotencyKey — generated when the BUTTON is first rendered,
  // not when the click is fired — and the server treats
  // (jobId, idempotencyKey) as one operator action. Subsequent clicks
  // with the same key get the same row back. When the operator later
  // intentionally wants ANOTHER copy, they re-load the page; the new
  // render generates a fresh key.
  //
  // In addition we disable the button for the duration of the in-flight
  // request (UX layer) AND we store the in-flight key in a ref so the
  // state survives React re-renders. Only one REPRINT per row can be
  // in-flight at a time.
  const inFlightAmbiguityRef = useRef<Set<string>>(new Set());
  async function acknowledgeAmbiguity(jobId: string, decision: "PRINTED" | "REPRINT", idempotencyKey: string) {
    if (inFlightAmbiguityRef.current.has(jobId)) return;
    inFlightAmbiguityRef.current.add(jobId);
    setResolvingJobId(jobId);
    setError(null);
    try {
      await apiFetch(`/api/admin/print-jobs/${jobId}/acknowledge-ambiguity`, {
        method: "POST",
        body: JSON.stringify({ decision, idempotencyKey }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri potvrdi štampe");
    } finally {
      setResolvingJobId(null);
      inFlightAmbiguityRef.current.delete(jobId);
    }
  }

  useEffect(() => {
    load();
    // 5s — dovoljno brzo da agent online/offline/promena štampača/heartbeat
    // izgledaju kao "automatski", a Admin ekran je posmatračka površina
    // (nema tipkanja/brzih tapova kao KDS) pa nema razloga za KDS-ov 4s.
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    apiFetch("/api/admin/workstations/agent-download")
      .then(setDownloadInfo)
      .catch(() => setDownloadInfo(null));
  }, []);

  // PRINTING P0 — Admin "Test" button drives the FULL physical-confirm
  // flow in one click, replacing the old behaviour that only requested
  // a technical test and left the operator to wonder if it actually
  // printed. Flow:
  //   1. Server queues a test print on the Agent (technical test, fast).
  //   2. We poll until the Agent reports SUCCEEDED or FAILED.
  //   3. If SUCCEEDED → show a HUMAN CONFIRMATION dialog. If the operator
  //      confirms, POST to /api/admin/workstations/{id}/routes/{type}/confirm
  //      to flip physicalTestConfirmed=true (the same endpoint the Setup
  //      wizard uses — converge on a single server-side transition).
  //   4. If FAILED → show the error and stop; the operator must fix the
  //      printer before retrying. We never auto-confirm a failed test.
  //
  // This is the Admin counterpart to the Setup wizard's HUMAN CONFIRMATION
  // step — same server endpoint, same audit entry, same effect. The two
  // paths converge so an operator can pick whichever fits the moment:
  //   - During initial install → use the Setup wizard (runs physical test
  //     locally on the same machine, faster feedback loop).
  //   - After upgrade or from a remote Admin → use this Admin button
  //     (runs the test remotely via the Agent, requires the operator to
  //     walk to the printer to verify the physical output).
  async function testPrint(workstationId: string, type: RouteType) {
    const key = `${workstationId}:${type}`;
    setTestingRoute(key);
    setError(null);
    try {
      // Step 1: queue the technical test.
      await apiFetch(`/api/admin/workstations/${workstationId}/test-print`, { method: "POST", body: JSON.stringify({ type }) });
      // Step 2: poll up to ~12s for the Agent to report the result.
      const deadline = Date.now() + 12000;
      let status: "PENDING" | "SUCCEEDED" | "FAILED" | null = "PENDING";
      let errorMsg: string | null = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const ws = (await apiFetch("/api/admin/workstations")).workstations?.find((w: Workstation) => w.id === workstationId);
        status = ws?.testPrintStatus ?? null;
        errorMsg = ws?.testPrintError ?? null;
        if (status === "SUCCEEDED" || status === "FAILED") break;
      }
      // Step 3 + 4: branch on the result.
      if (status !== "SUCCEEDED") {
        setError(errorMsg ? `Test štampa nije uspela: ${errorMsg}` : "Test štampa još uvek traje — proverite štampač i pokušajte ponovo.");
        await load();
        return;
      }
      const confirmMessage = `Test štampa za ${ROUTE_LABEL[type]} je uspešno poslata.\n\nDa li je test tiket fizički izašao iz štampača i da li je čitljiv?`;
      const proceed = typeof window === "undefined" ? true : window.confirm(confirmMessage);
      if (!proceed) {
        setError(`Test štampa za ${ROUTE_LABEL[type]} uspela, ali niste potvrdili fizički papir. Status ostaje "čeka fizičku potvrdu".`);
        await load();
        return;
      }
      // Step 5: flip physicalTestConfirmed via the same endpoint the
      // Setup wizard uses (convergent).
      await apiFetch(`/api/admin/workstations/${workstationId}/routes/${type}/confirm`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri zahtevu za test štampu");
    } finally {
      setTestingRoute(null);
    }
  }

  // PRINTING V2 FINAL — mode change must be a deliberate Admin action
  // (section 7), never a stray click: confirm() gates it, same convention
  // already used for "Opozovi" below. Pairing, credentials, routes, printer
  // discovery and print history are all untouched — only which workstation
  // resolveEligibleWorkstation considers eligible for the NEXT claim changes.
  async function changePrintingMode(next: PrintingMode) {
    if (next === printingMode || savingMode) return;
    const confirmMessage =
      next === "LOGIN_AWARE"
        ? "Prebaciti na REŽIM: Prema prijavljenom korisniku? Svaki računar će štampati prema ulozi trenutno prijavljenog korisnika na njemu, umesto po unapred podešenim rutama."
        : "Prebaciti na REŽIM: Centralno rutiranje? Rute štampe podešene ispod postaju odmah aktivne, bez obzira ko je prijavljen na računaru.";
    if (!confirm(confirmMessage)) return;
    setSavingMode(true);
    setError(null);
    try {
      await apiFetch("/api/admin/workstations/printing-mode", { method: "PUT", body: JSON.stringify({ printingMode: next }) });
      setPrintingModeState(next);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri promeni režima štampe");
    } finally {
      setSavingMode(false);
    }
  }

  async function createPairing() {
    if (!locationId) return;
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/workstations/pairings", {
        method: "POST",
        body: JSON.stringify({ locationId, name: newName.trim() || undefined }),
      });
      setJustCreatedCode({ pairingId: res.pairing.pairingId, code: res.pairing.code, expiresAt: res.pairing.expiresAt });
      setNewName("");
      setShowAddForm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri kreiranju uparivanja");
    } finally {
      setCreating(false);
    }
  }

  // Printing V2 Admin UX — the code-reveal panel's dismiss action is a REAL
  // cancel (DELETE the pairing session server-side), not just hiding the
  // code from view — otherwise a "cancelled" pairing would silently stay
  // consumable for its full 10-minute window after the Admin thought they
  // dismissed it.
  async function cancelJustCreatedCode() {
    if (!justCreatedCode) return;
    setError(null);
    try {
      await apiFetch(`/api/admin/workstations/pairings/${justCreatedCode.pairingId}`, { method: "DELETE" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri otkazivanju");
    } finally {
      setJustCreatedCode(null);
      setCodeCopied(false);
      await load();
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
    if (!confirm("Opozvati ovaj računar? Agent će odmah izgubiti pristup i biće potrebno novo uparivanje.")) return;
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
  // istim nazivom, korisno kad se agent ponovo instalira na istom ili
  // zamenskom računaru. Rute štampe OSTAJU nepromenjene na postojećem
  // računaru — ovo samo generiše kod za uspostavljanje NOVOG identiteta
  // (npr. reinstall), nikad ne menja Kuhinja/Šank/Račun podešavanja.
  function rePair(w: Workstation) {
    setNewName(w.name);
    setShowAddForm(true);
    setJustCreatedCode(null);
  }

  // Printing V2 — professional Admin -> Agent pairing handoff. Only works
  // when the browser tab is open ON the exact Windows computer being
  // paired (the custom scheme is registered by the installer on THAT
  // machine, apps/print-agent/installer/TableCorePrintAgent.iss
  // [Registry]) — same mechanism as vscode:// / slack:// / zoom://.
  // window.location.href (not window.open) is the standard technique:
  // browsers intercept the custom-scheme navigation and prompt "Open
  // TableCore Print Agent?" without actually navigating this Admin page
  // away or leaving a stray blank tab. If the Agent isn't installed or the
  // browser can't resolve the scheme, nothing visibly breaks here — the
  // "Kopiraj kod" fallback right next to it always still works.
  function openPrintAgent(code: string) {
    window.location.href = `tablecore-print://pair?code=${encodeURIComponent(code)}`;
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

  function draftKey(workstationId: string, type: RouteType): string {
    return `${workstationId}:${type}`;
  }
  function getRouteDraft(w: Workstation, type: RouteType): RouteDraft {
    const key = draftKey(w.id, type);
    const draft = routeDrafts[key];
    if (draft) return draft;
    const existing = routeOf(w, type);
    return {
      printerName: existing?.printerName ?? "",
      paperWidthMm: (existing?.paperWidthMm as 58 | 80) ?? 58,
      isEnabled: existing?.isEnabled ?? true,
      isPrimary: existing?.isPrimary ?? false,
    };
  }
  function patchRouteDraft(w: Workstation, type: RouteType, patch: Partial<RouteDraft>) {
    const key = draftKey(w.id, type);
    setRouteDrafts((prev) => ({ ...prev, [key]: { ...getRouteDraft(w, type), ...patch } }));
  }

  async function saveRoutes(w: Workstation) {
    setSavingRoutesId(w.id);
    setError(null);
    try {
      for (const type of ROUTE_TYPES) {
        const draft = getRouteDraft(w, type);
        await apiFetch(`/api/admin/workstations/${w.id}/routes/${type}`, {
          method: "PUT",
          body: JSON.stringify({
            printerName: draft.printerName.trim() || null,
            paperWidthMm: draft.printerName.trim() ? draft.paperWidthMm : null,
            isEnabled: draft.isEnabled,
            isPrimary: draft.isPrimary,
          }),
        });
      }
      setRouteDrafts((prev) => {
        const next = { ...prev };
        for (const type of ROUTE_TYPES) delete next[draftKey(w.id, type)];
        return next;
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Greška pri čuvanju ruta štampe");
    } finally {
      setSavingRoutesId(null);
    }
  }

  // Napredak koraka 1-6 je namerno IZVEDEN iz stvarnog stanja (workstation
  // lista/pending uparivanja/downloadInfo) — nikad ručno postavljen checkbox
  // koji bi mogao lagati administratora o tome šta je stvarno urađeno.
  const activeWorkstations = workstationList.filter((w) => !w.revokedAt);
  const anyPrinterConfigured = activeWorkstations.some((w) => w.printRoutes.some((r) => r.printerName));
  const anyTestSucceeded = activeWorkstations.some((w) => w.testPrintStatus === "SUCCEEDED");
  const anyReady = activeWorkstations.some((w) => ROUTE_TYPES.some((t) => routeReadiness(w, routeOf(w, t)) === "READY"));
  const setupSteps = [
    { label: "Preuzmi Print Agent", done: Boolean(downloadInfo?.available) },
    { label: "Dodaj računar", done: activeWorkstations.length > 0 || pendingPairings.length > 0 },
    { label: "Upari", done: activeWorkstations.length > 0 },
    { label: "Izaberi štampač", done: anyPrinterConfigured },
    { label: "Test štampa", done: anyTestSucceeded },
    { label: "Spremno", done: anyReady },
  ];

  const revokedWorkstations = workstationList.filter((w) => w.revokedAt);

  // PRINTING V2 FINAL — CENTRAL_ROUTING deterministic multi-agent routing:
  // the "Glavna" (primary) toggle only makes sense (and is only shown) once
  // more than one active workstation has an ENABLED route of the SAME type
  // in the SAME location — otherwise there is no ambiguity to resolve, and
  // showing it would just be Admin-panel clutter with today's single-Agent
  // physical reality (test_11). Irrelevant under LOGIN_AWARE (eligibility
  // there follows terminal login, never route priority) — never shown then.
  function multipleWorkstationsShareRoute(type: RouteType, locationId: string, excludeWorkstationId?: string): boolean {
    return activeWorkstations.some(
      (w) => w.locationId === locationId && w.id !== excludeWorkstationId && routeOf(w, type)?.isEnabled
    );
  }

  function renderRouteRow(w: Workstation, type: RouteType) {
    const route = routeOf(w, type);
    const draft = getRouteDraft(w, type);
    const readiness = routeReadiness(w, route);
    const revoked = Boolean(w.revokedAt);
    const printerOptions = w.availablePrinters ?? [];
    const testKey = `${w.id}:${type}`;
    const showPrimaryToggle =
      printingMode === "CENTRAL_ROUTING" && draft.isEnabled && multipleWorkstationsShareRoute(type, w.locationId, w.id);
    return (
      <div key={type} className="border-t border-line/60 py-2 first:border-t-0">
      <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[80px_1fr_90px_120px_auto]">
        <span className="text-xs font-semibold uppercase tracking-wide text-inkSoft">{ROUTE_LABEL[type]}</span>
        <select
          value={draft.printerName}
          onChange={(e) => patchRouteDraft(w, type, { printerName: e.target.value })}
          disabled={revoked}
          className="rounded-md border border-line px-2 py-1.5 text-xs text-ink disabled:opacity-50"
        >
          <option value="">— nije podešeno —</option>
          {draft.printerName && !printerOptions.includes(draft.printerName) && (
            <option value={draft.printerName}>{draft.printerName} (poslednje poznato)</option>
          )}
          {printerOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={draft.paperWidthMm}
          onChange={(e) => patchRouteDraft(w, type, { paperWidthMm: Number(e.target.value) as 58 | 80 })}
          disabled={revoked || !draft.printerName}
          className="rounded-md border border-line px-2 py-1.5 text-xs text-ink disabled:opacity-50"
        >
          <option value={58}>58mm</option>
          <option value={80}>80mm</option>
        </select>
        <span
          className={`justify-self-start rounded-full px-2 py-0.5 text-[11px] font-semibold sm:justify-self-center ${
            readiness === "READY" ? "bg-success/10 text-success" : readiness === "NOT_CONFIGURED" ? "bg-cream-200 text-inkSoft" : "bg-danger-soft text-danger"
          }`}
        >
          {READINESS_LABEL[readiness]}
        </span>
        <button
          type="button"
          onClick={() => testPrint(w.id, type)}
          disabled={revoked || !route?.printerName || testingRoute === testKey}
          className="justify-self-start text-xs font-semibold text-ink underline disabled:opacity-40 sm:justify-self-end"
        >
          Test {ROUTE_LABEL[type].toLowerCase()}
        </button>
      </div>
      {showPrimaryToggle && (
        <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-inkSoft">
          <input
            type="checkbox"
            checked={draft.isPrimary}
            onChange={(e) => patchRouteDraft(w, type, { isPrimary: e.target.checked })}
            disabled={revoked}
          />
          Glavna ruta za {ROUTE_LABEL[type].toLowerCase()} na ovoj lokaciji (kad više računara ima ovu rutu, samo glavni je preuzima)
        </label>
      )}
      {readiness === "AGENT_CANNOT_SEE" && (
        // PRINTING P0 — Service-side visibility probe surfaced here as
        // a dedicated, human-friendly warning. No mention of service
        // identity, per-user installs, or infrastructure. Actionable
        // next step is the same as the Setup wizard's error message.
        <p className="mt-1.5 rounded-md border border-danger/40 bg-danger-soft px-2 py-1.5 text-[11px] text-danger">
          TableCore servis ne može da pristupi štampaču <strong>{route?.printerName}</strong> —
          ponovo instalirajte drajver štampača sa opcijom „Za sve korisnike“ i restartujte računar.
        </p>
      )}
      {readiness === "NEEDS_CONFIRMATION" && (
        // PRINTING P0 — operator has not yet pressed "Da, test tiket
        // je uspešno odštampan" on the Setup wizard. The Admin "Test"
        // button above triggers BOTH the technical test AND the human
        // confirmation in one flow (see submitTestPrintAndConfirm),
        // closing the "spooler-success-is-READY" loophole.
        <p className="mt-1.5 rounded-md border border-warn/40 bg-warn-soft px-2 py-1.5 text-[11px] text-ink">
          Štampač je podešen ali čeka fizičku potvrdu — kliknite „Test {ROUTE_LABEL[type].toLowerCase()}“ i potvrdite da je tiket izašao.
        </p>
      )}
      </div>
    );
  }

  function renderWorkstationCard(w: Workstation) {
    const online = isOnline(w.lastSeenAt);
    const revoked = Boolean(w.revokedAt);
    return (
      <div key={w.id} className="rounded-md border border-line px-3 py-2.5 text-sm">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-medium text-ink">{w.name}</span>
            <span className="ml-2 text-xs text-inkSoft">{w.location.name}</span>
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
          <span>
            Dostupni štampači: {w.availablePrinters && w.availablePrinters.length > 0 ? w.availablePrinters.join(", ") : "nijedan prijavljen"}
          </span>
          <span>Verzija agenta: {w.agentVersion ?? "—"}</span>
          <span>Poslednji kontakt: {formatDateTime(w.lastSeenAt)}</span>
          <span>Poslednja uspešna komunikacija: {formatDateTime(w.lastSuccessfulCommunicationAt)}</span>
          <span>Poslednja predaja na štampu: {formatDateTime(w.lastPrintAt)}</span>
          {printingMode === "LOGIN_AWARE" && !revoked && (
            <span className={w.terminalSession ? "font-semibold text-success" : "text-inkSoft"}>
              Trenutna operativna uloga:{" "}
              {w.terminalSession ? ROUTE_LABEL[w.terminalSession.printRole] : "nijedna (niko prijavljen na ovom računaru)"}
            </span>
          )}
          {w.testPrintStatus === "PENDING" && (
            <span className="font-semibold text-inkSoft">
              Test štampa ({w.testPrintRouteType ? ROUTE_LABEL[w.testPrintRouteType] : "—"}): čeka se sledeći kontakt agenta…
            </span>
          )}
          {w.testPrintStatus === "SUCCEEDED" && (
            <span className="font-semibold text-success">
              Test štampa ({w.testPrintRouteType ? ROUTE_LABEL[w.testPrintRouteType] : "—"}) uspela ({formatDateTime(w.testPrintCompletedAt)})
            </span>
          )}
          {w.testPrintStatus === "FAILED" && (
            <span className="font-semibold text-danger">
              Test štampa ({w.testPrintRouteType ? ROUTE_LABEL[w.testPrintRouteType] : "—"}) nije uspela ({formatDateTime(w.testPrintCompletedAt)})
              {w.testPrintError ? `: ${w.testPrintError}` : ""}
            </span>
          )}
        </div>

        {!revoked && (
          <div className="mt-3 rounded-md border border-line/70 bg-cream-100/60 px-2.5 py-1.5">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-inkSoft">Rute štampe</p>
            {ROUTE_TYPES.map((type) => renderRouteRow(w, type))}
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => saveRoutes(w)}
                disabled={savingRoutesId === w.id}
                className="min-h-8 rounded-md bg-graphite px-3 text-xs font-semibold text-cream-100 disabled:opacity-40"
              >
                {savingRoutesId === w.id ? "Čuvanje…" : "Sačuvaj rute"}
              </button>
            </div>
          </div>
        )}

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
              Omogućen (isključi da privremeno zaustaviš automatsku štampu bez opoziva)
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
              <button
                type="button"
                onClick={() => startEditing(w)}
                disabled={busyId === w.id}
                className="text-xs font-semibold text-ink underline disabled:opacity-40"
              >
                Podešavanja
              </button>
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
          Omogućava tihu, automatsku štampu na računaru u kuhinji/šanku — bez otvaranja browsera, bez Chrome
          dijaloga za štampu i bez ručnog odobrenja po tiketu. Jedan uparen računar može imati više ruta štampe
          (Kuhinja, Šank, Račun) — isti fizički štampač sme da posluži sve tri.
        </p>
      </div>

      <div className="mb-4 rounded-md border border-line p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-inkSoft">Režim štampe</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => changePrintingMode("LOGIN_AWARE")}
            disabled={savingMode}
            className={`rounded-md border-2 p-3 text-left transition-colors disabled:opacity-60 ${
              printingMode === "LOGIN_AWARE" ? "border-gold bg-gold-soft" : "border-line hover:border-gold/50"
            }`}
          >
            <p className="text-sm font-semibold text-ink">Prema prijavljenom korisniku</p>
            <p className="mt-0.5 text-xs text-inkSoft">
              Računar štampa prema ulozi korisnika koji je trenutno prijavljen na njemu.
            </p>
          </button>
          <button
            type="button"
            onClick={() => changePrintingMode("CENTRAL_ROUTING")}
            disabled={savingMode}
            className={`rounded-md border-2 p-3 text-left transition-colors disabled:opacity-60 ${
              printingMode === "CENTRAL_ROUTING" ? "border-gold bg-gold-soft" : "border-line hover:border-gold/50"
            }`}
          >
            <p className="text-sm font-semibold text-ink">Centralno rutiranje</p>
            <p className="mt-0.5 text-xs text-inkSoft">
              Agent automatski šalje kuhinju, šank i račune na štampače podešene ispod, bez obzira ko je prijavljen na
              računaru.
            </p>
          </button>
        </div>
        <p className="mt-2 text-[11px] text-inkSoft">
          Trenutno aktivno: <strong>{PRINTING_MODE_LABEL[printingMode]}</strong>. Promena režima ne briše uparivanje,
          rute štampe ni istoriju štampe.
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
              Verzija {downloadInfo.version} · {downloadInfo.supportedOS}. Pokreni preuzeti fajl na računaru u
              kuhinji/šanku, prati podešavanje, pa unesi kod za uparivanje sa liste ispod.
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

      {/* PRINTING P0 — operator reconciliation surface. Plain-language
          phrasing: "Nije moguće potvrditi da li je tiket odštampan" —
          no infrastructure terminology (no "SUBMISSION_UNKNOWN", no
          "PrintJob", no "spooler", no "agent"). Two safe actions:
          "Već je odštampan" (confirms without reprint) and
          "Odštampaj ponovo" (creates a fresh reprint PrintJob, audited).
          Both call POST /api/admin/print-jobs/{id}/acknowledge-ambiguity
          with a stable per-row idempotencyKey — see acknowledgeAmbiguity
          above for the full double-click protection rationale. */}
      {ambiguityJobs.length > 0 && (
        <div className="mb-4 rounded-md border border-warn/40 bg-warn-soft px-3 py-2.5">
          <p className="text-xs font-semibold text-ink">
            Nije moguće potvrditi da li je tiket odštampan ({ambiguityJobs.length})
          </p>
          <p className="mt-1 text-[11px] text-inkSoft">
            Računar je izgubio kontakt sa štampačem baš u trenutku slanja. Tiket je <strong>moguće</strong> već
            izašao na papiru. Odštampavanje ponovo može napraviti duplu kopiju. Proverite štampač pre nego što
            izaberete jednu od dve opcije:
          </p>
          <ul className="mt-2 space-y-1.5">
            {ambiguityJobs.map((j) => {
              // PRINTING P0 — stable idempotency key per job per render.
              // Keyed on j.id (stable) so double-clicks with the SAME
              // key are recognized as one operator action; keyed on
              // j.createdAt-timestamp (stable per row) so two different
              // jobs do NOT collide. A page reload generates fresh keys,
              // which is the legitimate "operator wants another copy"
              // path — the server's dispatchKey is derived from this key.
              const idempotencyKey = `${j.id}-${new Date(j.createdAt).getTime()}-print`;
              const reprintKey = `${j.id}-${new Date(j.createdAt).getTime()}-reprint`;
              const busy = resolvingJobId === j.id;
              return (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/30 bg-cream-100 px-2.5 py-1.5 text-xs">
                <div className="min-w-0">
                  <span className="font-semibold text-ink">
                    {ROUTE_LABEL[j.type]} · Porudžbina #{j.orderId.slice(-6)}
                  </span>
                  <span className="ml-2 text-inkSoft">
                    {new Date(j.createdAt).toLocaleString("sr-Latn-RS")}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => acknowledgeAmbiguity(j.id, "PRINTED", idempotencyKey)}
                    disabled={busy}
                    className="rounded-md border border-success/40 bg-success-soft px-2.5 py-1 text-[11px] font-semibold text-success disabled:opacity-40"
                    title="Potvrdi da je tiket već fizički izašao"
                  >
                    Već je odštampan
                  </button>
                  <button
                    type="button"
                    onClick={() => acknowledgeAmbiguity(j.id, "REPRINT", reprintKey)}
                    disabled={busy}
                    className="rounded-md border border-gold/40 bg-gold-soft px-2.5 py-1 text-[11px] font-semibold text-ink disabled:opacity-40"
                    title="Kreira novi tiket i šalje ga ponovo. Duplira fizički papir ako je prethodni već izašao."
                  >
                    Odštampaj ponovo
                  </button>
                </div>
              </li>
              );
            })}
          </ul>
        </div>
      )}

      {justCreatedCode && (
        <div className="mb-4 rounded-md border border-gold/40 bg-gold-soft p-3">
          <p className="mb-1 text-xs font-semibold text-ink">Kod za uparivanje (unesi na Windows računaru)</p>
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-mono text-2xl font-bold tracking-wider text-ink">{justCreatedCode.code}</p>
            <button
              type="button"
              onClick={() => openPrintAgent(justCreatedCode.code)}
              className="min-h-9 rounded-md bg-graphite px-3 text-xs font-semibold text-cream-100 hover:bg-graphite/90"
            >
              Otvori TableCore Print Agent
            </button>
            <button
              type="button"
              onClick={() => copyPairingCode(justCreatedCode.code)}
              className="min-h-9 rounded-md border border-gold/50 bg-cream-100 px-3 text-xs font-semibold text-ink hover:bg-gold-soft"
            >
              {codeCopied ? "✓ Kopirano" : "Kopiraj kod"}
            </button>
          </div>
          <p className="mt-1 text-xs text-inkSoft">
            Ističe za {remainingMinutes(justCreatedCode.expiresAt)} min — prikazuje se samo ovde, jednom. Rute štampe
            (Kuhinja/Šank/Račun) podešavaš posle uparivanja, ispod.
          </p>
          <p className="mt-1 text-xs text-inkSoft">
            <strong>Otvori TableCore Print Agent</strong> radi samo na RAČUNARU koji uparuješ (i samo ako je agent već
            instaliran) — kod se automatski upiše, ti samo klikneš „Poveži“. Ako dugme ne radi (browser ne prepoznaje
            program), koristi <strong>Kopiraj kod</strong> i ručno otvori „Podešavanja radne stanice“ iz Start menija
            pa nalepi kod.
          </p>
          <button
            type="button"
            onClick={cancelJustCreatedCode}
            className="mt-2 text-xs font-semibold text-danger underline"
          >
            Otkaži
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
                      <span className="font-medium text-ink">{p.name || "Novi računar"}</span>
                      <span className="ml-2 text-xs text-inkSoft">
                        {p.location.name} · ističe za {remainingMinutes(p.expiresAt)} min
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

          <div className="mb-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-inkSoft">Računari</p>
            {activeWorkstations.length > 0 ? (
              <div className="space-y-2">{activeWorkstations.map(renderWorkstationCard)}</div>
            ) : (
              <p className="rounded-md border border-dashed border-line px-3 py-2 text-xs text-inkSoft">
                Još nijedan računar nije uparen. Dodaj računar dugmetom ispod.
              </p>
            )}
          </div>

          {revokedWorkstations.length > 0 && (
            <details className="mb-4 rounded-md border border-line">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-inkSoft">
                Neaktivni / opozvani računari ({revokedWorkstations.length})
              </summary>
              <div className="space-y-2 border-t border-line p-3">{revokedWorkstations.map(renderWorkstationCard)}</div>
            </details>
          )}

          {showAddForm ? (
            <div className="rounded-md border border-line p-3">
              <div className="mb-3">
                <label className="mb-1 block text-xs text-inkSoft">Naziv (opciono)</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="npr. Kuhinjski računar"
                  className="w-full max-w-sm rounded-md border border-line px-3 py-2 text-sm text-ink"
                />
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
              + Dodaj Print Agent računar
            </button>
          )}
        </>
      )}
    </Card>
  );
}
