// @vitest-environment jsdom
//
// Print Agent physical QA fix — the waiter /bill print action used to call
// printAndConfirm() with the default (browser) transport, which opens
// Chrome's own print dialog (window.print()) on the WAITER'S device —
// completely wrong for a receipt meant to print silently on POS-58 via the
// Windows Print Agent on a different computer. These tests pin: it never
// calls window.print(), it dispatches an authoritative RECEIPT PrintJob
// instead, and the browser-print path is preserved ONLY as an explicit,
// secondary fallback button.
//
// BUG #11 — payment already auto-dispatches the receipt automatically; a
// separate normal "Štampaj račun" action was redundant/confusing and has
// been removed. "Ponovo štampaj račun" is now the ONE normal post-payment
// print action (always an intentional NEW copy, never the automatic one).
import React, { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillClient } from "../../apps/web/app/waiter/tables/[tableId]/bill/bill-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../apps/web/components/ui/QuickLockButton", () => ({ QuickLockButton: () => null }));
vi.mock("../../apps/web/components/ui/LogoutButton", () => ({ LogoutButton: () => null }));
// The real TicketPrintPanel portals a .print-ticket-root into document.body
// for BrowserPrintTransport to find. Rendering it as null here means the
// fallback transport takes its OWN documented "no ticket root" path
// straight to window.print() — which is exactly the real behavior for a
// device with no printable DOM ticket, and lets these tests assert on
// window.print() directly without fighting iframe/measurement internals.
vi.mock("../../apps/web/components/printing/TicketPrintPanel", () => ({ TicketPrintPanel: () => null }));

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

const receipt = {
  sequenceNumber: 42,
  tableLabel: "5",
  waiterName: "Ana",
  paymentMethod: "CASH" as const,
  subtotal: "1000.00",
  taxTotal: "200.00",
  total: "1200.00",
  currency: "RSD",
  issuedAt: "2026-09-16T10:00:00Z",
  items: [{ name: "Burger", quantity: 1, lineTotal: "1200.00" }],
};

function receiptPrintJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    orderId: "order-1",
    type: "RECEIPT",
    station: null,
    status: "PENDING",
    attemptId: null,
    isAutomatic: true,
    resultOutcome: null,
    attemptCount: 0,
    content: { kind: "RECEIPT" },
    isReprint: false,
    createdAt: "2026-09-16T10:00:00Z",
    printedAt: null,
    failureReason: null,
    ...overrides,
  };
}

let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let windowPrint: ReturnType<typeof vi.fn>;
let printJobsResponse: unknown[];

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  windowPrint = vi.fn();
  vi.stubGlobal("print", windowPrint);
  printJobsResponse = [receiptPrintJob()];

  // P0.6 finding #2 — reset between tests; individual tests opt into a
  // known orderId via history.pushState to exercise the fast path.
  window.history.pushState({}, "", "/waiter/tables/5/bill");

  fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
    const path = String(input).split("?")[0];
    const method = options?.method ?? "GET";
    if (path === "/api/pos/orders" && method === "POST") return response({ order: { id: "order-1", status: "COMPLETED" } });
    if (path === "/api/pos/orders/order-1" && method === "GET") return response({ order: { id: "order-1", status: "COMPLETED" } });
    if (path === "/api/pos/orders/order-1/receipt" && method === "GET") return response({ receipt });
    if (path === "/api/pos/orders/order-1/print-jobs" && method === "GET") return response({ printJobs: printJobsResponse });
    if (path === "/api/pos/orders/order-1/receipt/print" && method === "POST") return response({ printJob: receiptPrintJob() });
    if (path === "/api/pos/orders/order-1/receipt/reprint" && method === "POST") return response({ printJob: receiptPrintJob({ id: "job-2", isReprint: true }) });
    if (path === "/api/pos/orders/order-1/print-jobs/job-1/begin" && method === "POST") return response({ printJob: { ...receiptPrintJob(), attemptId: "attempt-1", status: "PRINTING" } });
    if (path === "/api/pos/orders/order-1/print-jobs/job-1/start" && method === "POST") return response({ ok: true });
    if (path === "/api/pos/orders/order-1/print-jobs/job-1/confirm" && method === "POST") return response({ printJob: receiptPrintJob({ status: "PRINTED" }) });
    throw new Error(`Unexpected request ${method} ${input}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(h(BillClient, { tableId: "5" }));
  });
}

async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(button).toBeTruthy();
  await act(async () => {
    button!.click();
  });
}

describe("BillClient — primary receipt print goes through the Print Agent, never the browser dialog", () => {
  // BUG #11 — payment already auto-dispatches the receipt (billing-service.ts/
  // split-bill-service.ts); a separate normal "Štampaj račun" action next to
  // it was redundant and confusing. There must be exactly ONE normal
  // post-payment print action now.
  it("(A) does NOT expose the redundant 'Štampaj račun' action", async () => {
    await mount();
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Štampaj račun");
    expect(button).toBeUndefined();
  });

  it("(B) exposes exactly one normal print action: 'Ponovo štampaj račun'", async () => {
    await mount();
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Ponovo štampaj račun");
    expect(button).toBeTruthy();
  });

  it("'Ponovo štampaj račun' never calls window.print and dispatches the reprint endpoint (fresh idempotency key)", async () => {
    await mount();
    await click("Ponovo štampaj račun");

    expect(windowPrint).not.toHaveBeenCalled();
    const dispatchCalls = fetchMock.mock.calls.filter(([url, opts]) => url === "/api/pos/orders/order-1/receipt/reprint" && opts?.method === "POST");
    expect(dispatchCalls).toHaveLength(1);
    const body = JSON.parse((dispatchCalls[0][1] as RequestInit).body as string);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThan(0);
    // Never the browser-transport claim/start/confirm sequence.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/print-jobs/job-1/begin"))).toBe(false);
    expect(host.textContent).toContain("Račun poslat na štampu");
  });

  it("two separate clicks on 'Ponovo štampaj račun' each dispatch their own reprint request", async () => {
    await mount();
    await click("Ponovo štampaj račun");
    await click("Ponovo štampaj račun");

    const dispatchCalls = fetchMock.mock.calls.filter(([url, opts]) => url === "/api/pos/orders/order-1/receipt/reprint" && opts?.method === "POST");
    expect(dispatchCalls).toHaveLength(2);
    const keys = dispatchCalls.map(([, opts]) => JSON.parse((opts as RequestInit).body as string).idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]); // a genuinely new click is a genuinely new intent
  });

  it("the browser-print fallback is secondary, requires an existing PrintJob, and DOES use window.print when explicitly clicked", async () => {
    await mount();
    // Available immediately because a RECEIPT job already exists (auto-dispatched at payment).
    expect(host.textContent).toContain("Štampaj preko browsera");
    await click("Štampaj preko browsera");

    expect(windowPrint).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/print-jobs/job-1/begin"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/print-jobs/job-1/confirm"))).toBe(true);
  });

  it("the fallback is not shown before any PrintJob is known", async () => {
    printJobsResponse = [];
    await mount();
    expect(host.textContent).not.toContain("Štampaj preko browsera");
  });
});

describe("BillClient — P0.6 finding #2 (bill/receipt loading)", () => {
  it("with a known orderId (from the order screen), uses the cheap GET lookup and never calls openOrder", async () => {
    window.history.pushState({}, "", "/waiter/tables/5/bill?orderId=order-1");
    await mount();
    expect(fetchMock.mock.calls.some(([url, opts]) => url === "/api/pos/orders/order-1" && (opts?.method ?? "GET") === "GET")).toBe(true);
    expect(fetchMock.mock.calls.some(([url, opts]) => url === "/api/pos/orders" && opts?.method === "POST")).toBe(false);
    expect(host.textContent).toContain("Plaćanje uspešno");
  });

  it("without an orderId (direct navigation/back/refresh), falls back to the existing openOrder resolution unchanged", async () => {
    await mount();
    expect(fetchMock.mock.calls.some(([url, opts]) => url === "/api/pos/orders" && opts?.method === "POST")).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/pos/orders/order-1")).toBe(false);
    expect(host.textContent).toContain("Plaćanje uspešno");
  });

  it("shows contextual 'Pripremam račun…' while loading, not the generic 'Učitavanje…'", async () => {
    let resolveOrder!: (v: Response) => void;
    fetchMock.mockImplementationOnce(async () => new Promise<Response>((resolve) => { resolveOrder = resolve; }));
    await act(async () => {
      root.render(h(BillClient, { tableId: "5" }));
    });
    expect(host.textContent).toContain("Pripremam račun…");
    expect(host.textContent).not.toContain("Učitavanje…");
    await act(async () => {
      resolveOrder(response({ order: { id: "order-1", status: "COMPLETED" } }));
    });
  });
});
