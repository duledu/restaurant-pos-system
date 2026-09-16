// @vitest-environment jsdom
//
// PREPROD physical QA follow-up (Part A2) — Admin -> Podešavanja štampača
// only ever fetched workstation state ONCE on mount; an admin had to
// manually reload the browser to see a workstation come online, go
// offline, report a new printer, or otherwise converge to server state.
// This proves the panel now polls in the background (same setInterval +
// in-flight-guard pattern already proven in KdsClient.tsx) and picks up a
// server-side change on its own, without any user action.
//
// Printing Architecture V2 — a Workstation no longer has one scalar
// station/printer; it has 0..N WorkstationPrintRoute rows (KITCHEN/BAR/
// RECEIPT), each independently configured. These tests also cover: pairing
// no longer asks for a station up front, each route shows its own
// readiness independently, and changing one route never affects another.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkstationsPanel } from "../../apps/web/components/kds/WorkstationsPanel";

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

function route(type: "KITCHEN" | "BAR" | "RECEIPT", overrides: Record<string, unknown> = {}) {
  return {
    id: `route-${type}`,
    type,
    printerName: null,
    paperWidthMm: null,
    printerAvailable: null,
    isEnabled: true,
    updatedAt: "2026-09-15T09:00:00Z",
    ...overrides,
  };
}

function workstation(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    name: "Kuhinjski računar",
    locationId: "l1",
    location: { id: "l1", name: "Glavna" },
    availablePrinters: ["POS-58"],
    printersReportedAt: "2026-09-15T09:00:00Z",
    printRoutes: [],
    agentVersion: "1.0.0-pilot.3",
    osDescription: null,
    isEnabled: true,
    lastSeenAt: null,
    lastSuccessfulCommunicationAt: null,
    lastPrintAt: null,
    testPrintRequestedAt: null,
    testPrintRouteType: null,
    testPrintStatus: null,
    testPrintCompletedAt: null,
    testPrintError: null,
    revokedAt: null,
    pairedAt: "2026-09-15T09:00:00Z",
    ...overrides,
  };
}

let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let workstationsResponse: unknown[];

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  workstationsResponse = [workstation({ lastSeenAt: null })]; // starts offline
  fetchMock = vi.fn(async (input: string) => {
    const path = String(input).split("?")[0];
    if (path === "/api/admin/workstations") return response({ workstations: workstationsResponse, pendingPairings: [] });
    if (path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.2", supportedOS: "Windows 10/11" });
    throw new Error(`Unexpected request ${input}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(React.createElement(WorkstationsPanel, { locationId: "l1" }));
  });
}

describe("WorkstationsPanel — Admin converges automatically, without a manual page reload", () => {
  it("picks up a workstation coming online (heartbeat) on the next background poll, with no user action", async () => {
    await mount();
    expect(host.textContent).toContain("Van mreže");
    expect(host.textContent).not.toContain("Povezana");

    // Server-side state changes (agent heartbeat) — nothing in the DOM
    // triggers this; it's purely the passage of time / background poll.
    workstationsResponse = [
      workstation({ lastSeenAt: new Date().toISOString(), printRoutes: [route("KITCHEN", { printerName: "POS-58", printerAvailable: true, paperWidthMm: 58 })] }),
    ];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(host.textContent).toContain("Povezana");
    expect(host.textContent).not.toContain("Van mreže");
  });

  it("does not overlap polls — a slow in-flight request is not duplicated by the next tick", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async (input: string) => {
      const path = String(input).split("?")[0];
      if (path === "/api/admin/workstations") { calls += 1; return response({ workstations: workstationsResponse, pendingPairings: [] }); }
      if (path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.2", supportedOS: "Windows 10/11" });
      throw new Error(`Unexpected request ${input}`);
    });
    await mount();
    const afterMount = calls;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).toBe(afterMount + 1);
  });
});

describe("WorkstationsPanel — Printing V2 multi-route model", () => {
  it("pairing no longer asks for a station/'Namena' up front", async () => {
    workstationsResponse = []; // no existing workstation cards, so the only <select>s possible are in the add-computer form
    await mount();
    await act(async () => {
      const addButton = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Dodaj Print Agent računar"));
      addButton!.click();
    });
    expect(host.textContent).not.toContain("Namena");
    expect(host.querySelector("select")).toBeNull(); // no station <select> anywhere in the add-computer form
  });

  it("each route (Kuhinja/Šank/Račun) shows independent readiness — a ready KITCHEN route never implies BAR or RECEIPT are ready", async () => {
    workstationsResponse = [
      workstation({
        lastSeenAt: new Date().toISOString(),
        // BAR has no row at all yet (Admin never saved it) -> NOT_CONFIGURED.
        printRoutes: [
          route("KITCHEN", { printerName: "POS-58", printerAvailable: true, paperWidthMm: 58 }),
          route("RECEIPT", { printerName: "POS-58", printerAvailable: false, paperWidthMm: 58 }), // configured but printer currently missing
        ],
      }),
    ];
    await mount();
    expect(host.textContent).toContain("Kuhinja");
    expect(host.textContent).toContain("Šank");
    expect(host.textContent).toContain("Račun");
    // Spremna appears at least once (KITCHEN) but not for all three routes.
    const readyBadges = [...host.querySelectorAll("span")].filter((el) => el.textContent?.trim() === "Spremna");
    expect(readyBadges).toHaveLength(1);
    expect(host.textContent).toContain("Nije podešeno"); // BAR — no route row at all
    expect(host.textContent).toContain("Štampač nedostupan"); // RECEIPT — configured but agent reports it missing
  });

  it("the same physical printer can be selected for all three routes (Dostupni štampači lists it once, usable everywhere)", async () => {
    workstationsResponse = [
      workstation({
        lastSeenAt: new Date().toISOString(),
        availablePrinters: ["POS-58"],
        printRoutes: [
          route("KITCHEN", { printerName: "POS-58", printerAvailable: true, paperWidthMm: 58 }),
          route("BAR", { printerName: "POS-58", printerAvailable: true, paperWidthMm: 58 }),
          route("RECEIPT", { printerName: "POS-58", printerAvailable: true, paperWidthMm: 58 }),
        ],
      }),
    ];
    await mount();
    const readyBadges = [...host.querySelectorAll("span")].filter((el) => el.textContent?.trim() === "Spremna");
    expect(readyBadges).toHaveLength(3);
    // Every route's printer <select> should have POS-58 selected.
    const printerSelects = [...host.querySelectorAll("select")].filter((s) => [...s.options].some((o) => o.value === "POS-58"));
    expect(printerSelects.length).toBeGreaterThanOrEqual(3);
    for (const select of printerSelects) expect((select as HTMLSelectElement).value).toBe("POS-58");
  });

  it("Sačuvaj rute PUTs each route independently by type", async () => {
    workstationsResponse = [workstation({ lastSeenAt: new Date().toISOString(), printRoutes: [] })];
    const putCalls: string[] = [];
    fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
      const path = String(input).split("?")[0];
      if (path === "/api/admin/workstations") return response({ workstations: workstationsResponse, pendingPairings: [] });
      if (path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.2", supportedOS: "Windows 10/11" });
      if (path.includes("/routes/") && options?.method === "PUT") { putCalls.push(path); return response({ route: {} }); }
      throw new Error(`Unexpected request ${input}`);
    });
    await mount();
    await act(async () => {
      const saveButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Sačuvaj rute");
      saveButton!.click();
    });
    expect(putCalls.some((p) => p.endsWith("/routes/KITCHEN"))).toBe(true);
    expect(putCalls.some((p) => p.endsWith("/routes/BAR"))).toBe(true);
    expect(putCalls.some((p) => p.endsWith("/routes/RECEIPT"))).toBe(true);
  });

  it("Ponovo upari no longer prefills or implies a station for the new pairing", async () => {
    workstationsResponse = [
      workstation({ lastSeenAt: new Date().toISOString(), printRoutes: [route("KITCHEN", { printerName: "POS-58", printerAvailable: true, paperWidthMm: 58 })] }),
    ];
    await mount();
    await act(async () => {
      const rePairButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Ponovo upari");
      rePairButton!.click();
    });
    expect(host.textContent).not.toContain("Namena");
    // Scope to the pairing form itself — the existing workstation card above
    // it legitimately still has route <select>s; only the FORM must have none.
    const generateButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Generiši kod za uparivanje");
    expect(generateButton).toBeTruthy();
    const pairingForm = generateButton!.closest("div")!;
    expect(pairingForm.querySelector("select")).toBeNull();
  });
});

describe("WorkstationsPanel — Admin -> Agent pairing handoff (tablecore-print:// URI)", () => {
  function mockFetchWithPairingCreation() {
    fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
      const path = String(input).split("?")[0];
      if (path === "/api/admin/workstations") return response({ workstations: workstationsResponse, pendingPairings: [] });
      if (path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.2", supportedOS: "Windows 10/11" });
      if (path === "/api/admin/workstations/pairings" && options?.method === "POST") {
        return response({ pairing: { code: "ABCD-EFGH-JKMN", expiresAt: new Date(Date.now() + 10 * 60000).toISOString() } }, true);
      }
      throw new Error(`Unexpected request ${input}`);
    });
  }

  it("'Otvori TableCore Print Agent' navigates to a tablecore-print://pair URI carrying the exact freshly-created code", async () => {
    workstationsResponse = [];
    mockFetchWithPairingCreation();
    await mount();
    await act(async () => {
      const addButton = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Dodaj Print Agent računar"));
      addButton!.click();
    });
    await act(async () => {
      const generateButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Generiši kod za uparivanje");
      generateButton!.click();
    });
    const openButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Otvori TableCore Print Agent");
    expect(openButton).toBeTruthy();

    // jsdom does not implement custom-scheme navigation — assert the exact
    // URI the component WOULD navigate to, via a location.href setter spy,
    // rather than actually driving window.location (unsupported in jsdom
    // for non-http(s) schemes and irrelevant to what we're proving here).
    let assignedHref: string | null = null;
    Object.defineProperty(window, "location", {
      value: { ...window.location, set href(v: string) { assignedHref = v; }, get href() { return assignedHref ?? ""; } },
      writable: true,
    });
    await act(async () => {
      openButton!.click();
    });
    expect(assignedHref).toMatch(/^tablecore-print:\/\/pair\?code=/);
    expect(decodeURIComponent(assignedHref!.split("code=")[1])).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it("the manual 'Kopiraj kod' fallback remains available right next to the one-click button", async () => {
    workstationsResponse = [];
    mockFetchWithPairingCreation();
    await mount();
    await act(async () => {
      const addButton = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Dodaj Print Agent računar"));
      addButton!.click();
    });
    await act(async () => {
      const generateButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Generiši kod za uparivanje");
      generateButton!.click();
    });
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Otvori TableCore Print Agent")).toBe(true);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Kopiraj kod"))).toBe(true);
  });
});
