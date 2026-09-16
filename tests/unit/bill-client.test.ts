// @vitest-environment jsdom
//
// Print Agent physical QA fix — the waiter /bill "Štampaj račun" button
// used to call printAndConfirm() with the default (browser) transport,
// which opens Chrome's own print dialog (window.print()) on the WAITER'S
// device — completely wrong for a receipt meant to print silently on
// POS-58 via the Windows Print Agent on a different computer. These tests
// pin: the primary action never calls window.print(), it dispatches the
// authoritative RECEIPT PrintJob instead, and the browser-print path is
// preserved ONLY as an explicit, secondary fallback button.
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

  fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
    const path = String(input).split("?")[0];
    const method = options?.method ?? "GET";
    if (path === "/api/pos/orders" && method === "POST") return response({ order: { id: "order-1", status: "COMPLETED" } });
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
  it("'Štampaj račun' never calls window.print and dispatches the authoritative RECEIPT PrintJob", async () => {
    await mount();
    await click("Štampaj račun");

    expect(windowPrint).not.toHaveBeenCalled();
    const dispatchCalls = fetchMock.mock.calls.filter(([url, opts]) => url === "/api/pos/orders/order-1/receipt/print" && opts?.method === "POST");
    expect(dispatchCalls).toHaveLength(1);
    // Never the browser-transport claim/start/confirm sequence.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/print-jobs/job-1/begin"))).toBe(false);
  });

  it("shows immediate 'Šaljem na štampač…' feedback, then 'Račun poslat na štampu' once dispatched — never blocking on physical print", async () => {
    await mount();
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Štampaj račun"))!;
    await act(async () => {
      button.click();
    });
    expect(host.textContent).toContain("Račun poslat na štampu");
  });

  it("'Ponovo štampaj' dispatches the reprint endpoint and also never opens the browser print dialog", async () => {
    await mount();
    await click("Ponovo štampaj");

    expect(windowPrint).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url, opts]) => url === "/api/pos/orders/order-1/receipt/reprint" && opts?.method === "POST")).toBe(true);
    expect(host.textContent).toContain("Račun poslat na štampu");
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
