/**
 * Faza 6 — klijentski helper za PrintJob tok. Browser štampa je klijentska
 * po prirodi (window.print()) — server samo priprema/vraća sadržaj; ovaj
 * modul ga dovlači, pokreće štampu i potvrđuje ishod nazad na server.
 */

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
 */
export async function printAndConfirm(orderId: string, jobId: string): Promise<void> {
  window.print();
  await confirmPrintJob(orderId, jobId, { success: true });
}
