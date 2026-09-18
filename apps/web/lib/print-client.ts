/**
 * Faza 6 — klijentski helper za PrintJob tok. Browser štampa je klijentska
 * po prirodi (window.print()) — server samo priprema/vraća sadržaj; ovaj
 * modul ga dovlači, pokreće štampu i potvrđuje ishod nazad na server.
 */
import { defaultPrintTransport, type PrintTransport } from "./print-transport";

export interface PrintJob {
  id: string;
  orderId: string;
  type: "KITCHEN" | "BAR" | "RECEIPT";
  station: "KITCHEN" | "BAR" | null;
  status: "PENDING" | "PRINTING" | "PRINTED" | "FAILED" | "SUBMISSION_UNKNOWN" | "SUPPRESSED";
  attemptId: string | null;
  isAutomatic: boolean;
  resultOutcome: string | null;
  attemptCount: number;
  content: unknown;
  isReprint: boolean;
  createdAt: string;
  printedAt: string | null;
  failureReason: string | null;
}

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body;
}

export async function fetchPrintJobs(orderId: string): Promise<PrintJob[]> {
  const body = await apiFetch(`/api/pos/orders/${orderId}/print-jobs`);
  return body.printJobs as PrintJob[];
}

export async function confirmPrintJob(
  orderId: string,
  jobId: string,
  result: { attemptId: string; outcome: "TRANSPORT_COMPLETED" | "SUBMITTED_TO_SPOOLER" | "FAILED_BEFORE_SUBMISSION" | "SUBMISSION_UNKNOWN"; errorMessage?: string }
): Promise<PrintJob> {
  const body = await apiFetch(`/api/pos/orders/${orderId}/print-jobs/${jobId}/confirm`, {
    method: "POST",
    body: JSON.stringify(result),
  });
  return body.printJob as PrintJob;
}

export async function retryPrintJob(orderId: string, jobId: string): Promise<PrintJob> {
  const body = await apiFetch(`/api/pos/orders/${orderId}/print-jobs/${jobId}/retry`, { method: "POST" });
  return body.printJob as PrintJob;
}

/**
 * Atomski "claim" koraka PENDING -> PRINTING PRE automatske štampe (vidi
 * beginPrintAttempt u print-service.ts). Vraća `null` (ne baca grešku) kad
 * je red već preuzet — pozivalac (auto-print red čekanja na KDS-u) to mora
 * tiho preskočiti, ne prikazati kao grešku.
 */
export async function beginPrintJob(orderId: string, jobId: string): Promise<PrintJob | null> {
  const res = await fetch(`/api/pos/orders/${orderId}/print-jobs/${jobId}/begin`, {
    method: "POST", headers: { "X-TableCore-Print-Protocol": "2" },
  });
  if (res.status === 409) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body.printJob as PrintJob;
}

// Server-autoritativan izvor za KDS (i Admin) prikaz spremnosti štampača
// (Problem 3 + Part 13 ispravka) — NIKAD QZ/browser localStorage. `state`
// je JEDINO diskriminisano stanje koje treba prikazati; hasWorkstation/
// isOnline ostaju izloženi radi kompatibilnosti/detaljnijeg prikaza gde
// zatreba, ali `state` već uračunava i konfigurisan/dostupan štampač
// (agent online sa NEDOSTUPNIM štampačem NIKAD ne prijavljuje READY).
export type PrinterReadinessState = "READY" | "AGENT_OFFLINE" | "PRINTER_UNAVAILABLE" | "NOT_CONFIGURED";

export interface StationPrinterStatus {
  hasWorkstation: boolean;
  isOnline: boolean;
  state: PrinterReadinessState;
}

export interface PendingStationPrintJobs {
  jobs: PrintJob[];
  autoPrintEligible: boolean;
  // Faza 2B — QZ koegzistencija: true kad postoji bar jedna omogućena,
  // neopozvana radna stanica sa nedavnim heartbeat-om za TAČNO ovu
  // restoran/lokacija/stanica kombinaciju (agentPrinting.stationPrinterStatus's
  // isOnline). KdsClient.tsx ovo koristi da PASIVNO povuče sopstveni
  // auto-claim kad je Print Agent aktivan — browser/QZ i agent se NIKAD ne
  // takmiče za iste redove (duplikat je već strukturno nemoguć preko
  // beginPrintAttempt-a, ovo sprečava samo nasumično/nepotrebno takmičenje).
  agentActiveForStation: boolean;
  printerStatus: StationPrinterStatus;
  // Po-poslu (ne po-stanici) signal — bar jedan FAILED/SUBMISSION_UNKNOWN
  // tiket u `jobs` iznad. Prikazuje se kao "Poslednja štampa nije uspela"
  // SAMO kad je stanica inače READY (vidi KdsClient.tsx) — istorijski
  // neuspeh ne sme trajno prikazivati zdrav štampač kao pokvaren.
  hasRecentFailure: boolean;
}

export async function fetchPendingStationPrintJobs(station: "KITCHEN" | "BAR", locationId: string): Promise<PendingStationPrintJobs> {
  const base = station === "KITCHEN" ? "/api/production/kitchen" : "/api/production/bar";
  const body = await apiFetch(`${base}/print-jobs?locationId=${locationId}`);
  return {
    jobs: body.jobs as PrintJob[],
    autoPrintEligible: Boolean(body.autoPrintEligible),
    agentActiveForStation: Boolean(body.agentActiveForStation),
    printerStatus: {
      hasWorkstation: Boolean(body.printerStatus?.hasWorkstation),
      isOnline: Boolean(body.printerStatus?.isOnline),
      state: (body.printerStatus?.state as PrinterReadinessState) ?? "NOT_CONFIGURED",
    },
    hasRecentFailure: Boolean(body.hasRecentFailure),
  };
}

/**
 * Primarna "Štampaj račun" akcija (konobarski /bill ekran) — Print Agent
 * fizička QA ispravka. Server garantuje da autoritativan RECEIPT PrintJob
 * postoji (idempotentno, isti dispatchKey kao automatski dispatch pri
 * naplati — vidi printReceipt u print-service.ts); Windows Print Agent
 * (potpuno nezavisna poll/claim petlja, drugi računar) ga preuzima i
 * fizički štampa. NAMERNO ne poziva printAndConfirm/beginPrintJob/
 * defaultPrintTransport — ovaj poziv NIKAD ne otvara browser print dijalog
 * i NIKAD ne čeka fizičku štampu (samo dispatch, ne ACK).
 */
export async function printReceipt(orderId: string): Promise<PrintJob> {
  const body = await apiFetch(`/api/pos/orders/${orderId}/receipt/print`, { method: "POST" });
  return body.printJob as PrintJob;
}

// Per-order in-flight `reprintReceipt` promise map. Module-scope is safe —
// only bill-client.tsx calls reprintReceipt in this app, and React 18
// event-loop batching is the only case that benefits from dedup.
const inflightReprintByOrder = new Map<string, Promise<PrintJob>>();

export async function reprintReceipt(orderId: string): Promise<PrintJob> {
  // Physical-QA FIX #12 — Rapid double-click (React 18 batches setPrintBusy
  // so two clicks that fire inside the same event loop tick BOTH see
  // printBusy === false and proceed) must NOT produce two physical prints.
  // The server already deduplicates on
  //   @@unique([orderId, dispatchKey = "receipt-reprint:<paymentId>:<key>"])
  // — but only if the SAME `idempotencyKey` reaches it for retries of the
  // SAME user intent. We pin the in-flight request per orderId here: the
  // first click of a user action generates one UUID and reuses it for any
  // subsequent click that arrives before this call resolves; a click that
  // arrives AFTER resolution is a fresh intent and gets a fresh UUID.
  // This mirrors the explicit-request-identity pattern already used by
  // acknowledgePrintAmbiguity (see print-service.ts handleReprint ack).
  const inflight = inflightReprintByOrder.get(orderId);
  if (inflight) return inflight;
  const idempotencyKey = crypto.randomUUID();
  const promise = apiFetch(`/api/pos/orders/${orderId}/receipt/reprint`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey }),
  }).then((body) => body.printJob as PrintJob);
  inflightReprintByOrder.set(orderId, promise);
  try {
    return await promise;
  } finally {
    inflightReprintByOrder.delete(orderId);
  }
}

/** Claim, receive one-shot start permission, invoke transport, then acknowledge that attempt. */
export async function printAndConfirm(orderId: string, jobId: string, transport: PrintTransport = defaultPrintTransport, claimedAttemptId?: string | null): Promise<void> {
  const attemptId = claimedAttemptId ?? (await beginPrintJob(orderId, jobId))?.attemptId;
  if (!attemptId) throw new Error("Tiket nije preuzet; osvežite stanje ili zatražite novi otisak.");
  // Must receive one-shot permission BEFORE invoking any physical/browser transport.
  await apiFetch(`/api/pos/orders/${orderId}/print-jobs/${jobId}/start`, {
    method: "POST", body: JSON.stringify({ attemptId }),
  });
  try {
    await transport.print();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Greška pri štampi";
    const beforeSubmission = err instanceof Error && ["QzUnavailableError", "QzPrinterNotFoundError"].includes(err.name);
    await confirmPrintJob(orderId, jobId, { attemptId,
      outcome: beforeSubmission ? "FAILED_BEFORE_SUBMISSION" : "SUBMISSION_UNKNOWN", errorMessage: message.slice(0, 500) }).catch(() => {});
    throw err;
  }
  // A lost success acknowledgement must NEVER be followed by a failure report or another print.
  await confirmPrintJob(orderId, jobId, { attemptId, outcome: "TRANSPORT_COMPLETED" });
}

export async function requestStationPrint(orderId: string, station: "KITCHEN" | "BAR", idempotencyKey: string, originalJobId?: string): Promise<PrintJob> {
  const body = await apiFetch(`/api/pos/orders/${orderId}/print-jobs`, { method: "POST",
    body: JSON.stringify({ station, idempotencyKey, originalJobId }) });
  return body.printJob;
}
