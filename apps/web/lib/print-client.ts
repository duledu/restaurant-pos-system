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
  status: "PENDING" | "PRINTING" | "PRINTED" | "FAILED";
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
  result: { success: boolean; errorMessage?: string }
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
  const res = await fetch(`/api/pos/orders/${orderId}/print-jobs/${jobId}/begin`, { method: "POST" });
  if (res.status === 409) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Greška (${res.status})`);
  return body.printJob as PrintJob;
}

export interface PendingStationPrintJobs {
  jobs: PrintJob[];
  autoPrintEligible: boolean;
}

export async function fetchPendingStationPrintJobs(station: "KITCHEN" | "BAR", locationId: string): Promise<PendingStationPrintJobs> {
  const base = station === "KITCHEN" ? "/api/production/kitchen" : "/api/production/bar";
  const body = await apiFetch(`${base}/print-jobs?locationId=${locationId}`);
  return { jobs: body.jobs as PrintJob[], autoPrintEligible: Boolean(body.autoPrintEligible) };
}

export async function reprintReceipt(orderId: string): Promise<PrintJob> {
  const body = await apiFetch(`/api/pos/orders/${orderId}/receipt/reprint`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });
  return body.printJob as PrintJob;
}

/**
 * Pokreće browser print dijalog nad elementom sa `printRootId` (mora imati
 * klasu print-ticket-root/print-report-root — vidi print-thermal.css/
 * print-report.css) i potvrđuje ishod na server. window.print() je
 * sinhrono blokirajući u većini browsera pa se "success" tretira kao
 * najbolji dostupan signal — korisnik i dalje može ručno da klikne
 * "Ponovi" ako fizička štampa nije uspela (npr. printer offline).
 *
 * Ako window.print() ili sam confirm poziv baci grešku (npr. browser bez
 * print podrške, mreža dole tokom confirm-a), red NIKAD ne sme ostati
 * "zaglavljen" bez ishoda — pokušava se best-effort da se markira FAILED
 * (vidljivo/retryable, zahtev #4) umesto da tiho ostane u prethodnom stanju.
 */
export async function printAndConfirm(orderId: string, jobId: string, transport: PrintTransport = defaultPrintTransport): Promise<void> {
  try {
    await transport.print();
    await confirmPrintJob(orderId, jobId, { success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Greška pri štampi";
    await confirmPrintJob(orderId, jobId, { success: false, errorMessage: message }).catch(() => {});
    throw err;
  }
}
