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

export interface PendingStationPrintJobs {
  jobs: PrintJob[];
  autoPrintEligible: boolean;
  // Faza 2B — QZ koegzistencija: true kad postoji bar jedna omogućena,
  // neopozvana radna stanica sa nedavnim heartbeat-om za TAČNO ovu
  // restoran/lokacija/stanica kombinaciju (agentPrinting.isAgentActiveForStation).
  // KdsClient.tsx ovo koristi da PASIVNO povuče sopstveni auto-claim kad je
  // Print Agent aktivan — browser/QZ i agent se NIKAD ne takmiče za iste
  // redove (duplikat je već strukturno nemoguć preko beginPrintAttempt-a,
  // ovo sprečava samo nasumično/nepotrebno takmičenje).
  agentActiveForStation: boolean;
}

export async function fetchPendingStationPrintJobs(station: "KITCHEN" | "BAR", locationId: string): Promise<PendingStationPrintJobs> {
  const base = station === "KITCHEN" ? "/api/production/kitchen" : "/api/production/bar";
  const body = await apiFetch(`${base}/print-jobs?locationId=${locationId}`);
  return {
    jobs: body.jobs as PrintJob[],
    autoPrintEligible: Boolean(body.autoPrintEligible),
    agentActiveForStation: Boolean(body.agentActiveForStation),
  };
}

export async function reprintReceipt(orderId: string): Promise<PrintJob> {
  const body = await apiFetch(`/api/pos/orders/${orderId}/receipt/reprint`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });
  return body.printJob as PrintJob;
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
