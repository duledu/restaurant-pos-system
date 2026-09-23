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
    isPrimary: false,
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
    terminalSession: null,
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
let printingModeResponse: "LOGIN_AWARE" | "CENTRAL_ROUTING";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  workstationsResponse = [workstation({ lastSeenAt: null })]; // starts offline
  printingModeResponse = "CENTRAL_ROUTING";
  fetchMock = vi.fn(async (input: string) => {
    const path = String(input).split("?")[0];
    if (path === "/api/admin/workstations") return response({ workstations: workstationsResponse, pendingPairings: [], printingMode: printingModeResponse });
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

  it("false-\"Štampač nedostupan\" regression — printerAvailable:null (unconfirmed since last save) but the printer IS in availablePrinters shows Spremna, not Štampač nedostupan", async () => {
    // Physical PREPROD QA (pilot.5, test_11): POS-58 was reported in
    // availablePrinters, selectable, and physically printing, yet Admin
    // showed a hard red "Štampač nedostupan" for all three routes. Root
    // cause: every route save resets printerAvailable to null pending
    // reconfirmation, and null was treated identically to a proven "false".
    workstationsResponse = [
      workstation({
        lastSeenAt: new Date().toISOString(),
        availablePrinters: ["POS-58", "Microsoft Print to PDF"],
        printRoutes: [
          route("KITCHEN", { printerName: "POS-58", printerAvailable: null, paperWidthMm: 58 }),
          route("BAR", { printerName: "POS-58", printerAvailable: null, paperWidthMm: 58 }),
          route("RECEIPT", { printerName: "POS-58", printerAvailable: null, paperWidthMm: 58 }),
        ],
      }),
    ];
    await mount();
    expect(host.textContent).not.toContain("Štampač nedostupan");
    const readyBadges = [...host.querySelectorAll("span")].filter((el) => el.textContent?.trim() === "Spremna");
    expect(readyBadges).toHaveLength(3);
  });

  it("false-\"Štampač nedostupan\" regression — printerAvailable:null and the printer is genuinely NOT in availablePrinters still shows Štampač nedostupan", async () => {
    workstationsResponse = [
      workstation({
        lastSeenAt: new Date().toISOString(),
        availablePrinters: ["Microsoft Print to PDF"],
        printRoutes: [route("KITCHEN", { printerName: "POS-58", printerAvailable: null, paperWidthMm: 58 })],
      }),
    ];
    await mount();
    expect(host.textContent).toContain("Štampač nedostupan");
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

  it("Sačuvaj podešavanja PUTs each route independently by type", async () => {
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
    // BUG #2 — with no operator edits, the Save button is now DISABLED.
    // To exercise the multi-PUT path we synthesize one explicit draft
    // edit (the only legitimate way to enable the button after the fix),
    // then click Save and verify all three route types are PUT.
    await act(async () => {
      const printerSelects = [...host.querySelectorAll("select")].filter((s) => [...s.options].some((o) => o.value === "POS-58"));
      // pick a route with a known empty select, then drive a change event
      const target = printerSelects[0] as HTMLSelectElement;
      target.value = "POS-58";
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      const saveButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Sačuvaj podešavanja");
      expect(saveButton).toBeTruthy();
      saveButton!.click();
    });
    expect(putCalls.some((p) => p.endsWith("/routes/KITCHEN"))).toBe(true);
    expect(putCalls.some((p) => p.endsWith("/routes/BAR"))).toBe(true);
    expect(putCalls.some((p) => p.endsWith("/routes/RECEIPT"))).toBe(true);
  });

  // Admin re-pair dead-end fix (physical QA finding) — "Ponovo upari" used
  // to only reveal a form with its OWN separate "Generiši kod" button,
  // which the Admin visibly clicked to create a pending pairing without
  // ever seeing a code (workstation ends up under "Uparivanja na čekanju"
  // with no code and no obvious next step). It now creates the pairing AND
  // reveals the code in a single click, through the exact same
  // justCreatedCode panel "Dodaj računar" already used — no new mechanism,
  // still implies no station/route (Printing V2: routes are independent
  // of the pairing session, configured after, per workstation).
  it("Ponovo upari immediately creates a pairing and reveals the code — no dead end, no implied station", async () => {
    workstationsResponse = [
      workstation({ lastSeenAt: new Date().toISOString(), printRoutes: [route("KITCHEN", { printerName: "POS-58", printerAvailable: true, paperWidthMm: 58 })] }),
    ];
    let createBody: unknown = null;
    // Mirrors mockFetchWithPairingCreation below — the real server keeps a
    // freshly created pairing in pendingPairings until consumed/cancelled;
    // WorkstationsPanel's own load() nulls justCreatedCode the instant the
    // pairing ID it's showing stops appearing there (see the load() effect),
    // so a mock that always returns an empty list would immediately (and
    // incorrectly) hide the very code this test exists to prove is shown.
    let pending: { id: string; name: string | null; locationId: string; location: { id: string; name: string }; expiresAt: string; createdAt: string }[] = [];
    fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
      const path = String(input).split("?")[0];
      if (path === "/api/admin/workstations") return response({ workstations: workstationsResponse, pendingPairings: pending, printingMode: printingModeResponse });
      if (path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.2", supportedOS: "Windows 10/11" });
      if (path === "/api/admin/workstations/pairings" && options?.method === "POST") {
        createBody = JSON.parse(options.body as string);
        const expiresAt = new Date(Date.now() + 600_000).toISOString();
        pending = [...pending, { id: "p-1", name: (createBody as { name?: string }).name ?? null, locationId: "l1", location: { id: "l1", name: "Glavna" }, expiresAt, createdAt: new Date().toISOString() }];
        return response({ pairing: { pairingId: "p-1", code: "AAAA-BBBB-CCCC", expiresAt } });
      }
      throw new Error(`Unexpected request ${input}`);
    });
    await mount();
    await act(async () => {
      const rePairButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Ponovo upari");
      rePairButton!.click();
    });
    // No form/select step — the request went out with the workstation's
    // own name, no station/route implied.
    expect(createBody).toEqual({ locationId: "l1", name: "Kuhinjski računar" });
    expect(host.textContent).not.toContain("Namena");
    // The code is visible immediately, same panel as "Dodaj računar".
    expect(host.textContent).toContain("AAAA-BBBB-CCCC");
    expect(host.textContent).toContain("Otvori TableCore Print Agent");
  });
});

describe("WorkstationsPanel — Admin -> Agent pairing handoff (tablecore-print:// URI)", () => {
  // Mirrors the REAL server: a created pairing shows up in pendingPairings
  // (by id) until it's consumed/cancelled/expired — needed so the
  // auto-dismiss-on-resolve behavior (see `load()`) can be genuinely
  // exercised rather than trivially true against an always-empty list.
  function mockFetchWithPairingCreation() {
    let pending: { id: string; name: string | null; locationId: string; location: { id: string; name: string }; expiresAt: string; createdAt: string }[] = [];
    fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
      const path = String(input).split("?")[0];
      if (path === "/api/admin/workstations") return response({ workstations: workstationsResponse, pendingPairings: pending });
      if (path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.2", supportedOS: "Windows 10/11" });
      if (path === "/api/admin/workstations/pairings" && options?.method === "POST") {
        const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
        pending = [...pending, { id: "pairing-1", name: null, locationId: "l1", location: { id: "l1", name: "Glavna" }, expiresAt, createdAt: new Date().toISOString() }];
        return response({ pairing: { pairingId: "pairing-1", code: "ABCD-EFGH-JKMN", expiresAt } }, true);
      }
      if (path === "/api/admin/workstations/pairings/pairing-1" && options?.method === "DELETE") {
        pending = pending.filter((p) => p.id !== "pairing-1");
        return response({ id: "pairing-1", status: "CANCELLED" });
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

  it("'Otkaži' on the code panel actually cancels the pairing server-side, not just hides the code", async () => {
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
    expect(host.textContent).toContain("ABCD-EFGH-JKMN");

    const deleteCalls: string[] = [];
    const priorImpl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
      if (String(input).endsWith("/pairings/pairing-1") && options?.method === "DELETE") deleteCalls.push(String(input));
      return priorImpl(input, options);
    });
    await act(async () => {
      const cancelButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Otkaži");
      cancelButton!.click();
    });
    expect(deleteCalls).toHaveLength(1);
    expect(host.textContent).not.toContain("ABCD-EFGH-JKMN");
  });

  it("the code panel auto-resolves (disappears) once the pairing is no longer pending — no manual dismissal or page refresh needed", async () => {
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
    expect(host.textContent).toContain("ABCD-EFGH-JKMN");

    // Simulate the Agent successfully consuming the code server-side (a
    // real pairing being CONSUMED removes it from pendingPairings) and the
    // newly connected computer appearing — both from the SAME next poll,
    // no button click involved.
    workstationsResponse = [workstation({ name: "komp_test", lastSeenAt: new Date().toISOString() })];
    fetchMock.mockImplementation(async (input: string) => {
      const path = String(input).split("?")[0];
      if (path === "/api/admin/workstations") return response({ workstations: workstationsResponse, pendingPairings: [] });
      if (path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.2", supportedOS: "Windows 10/11" });
      throw new Error(`Unexpected request ${input}`);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(host.textContent).not.toContain("ABCD-EFGH-JKMN");
    expect(host.textContent).toContain("komp_test");
  });
});

describe("WorkstationsPanel — Printing V2 Final (printing modes + deterministic CENTRAL_ROUTING)", () => {
  it("shows both printing mode options, defaults to the server-reported mode, and PUTs a confirmed change", async () => {
    printingModeResponse = "CENTRAL_ROUTING";
    vi.stubGlobal("confirm", vi.fn(() => true));
    const putCalls: unknown[] = [];
    fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
      const path = String(input).split("?")[0];
      if (path === "/api/admin/workstations") return response({ workstations: workstationsResponse, pendingPairings: [], printingMode: printingModeResponse });
      if (path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.2", supportedOS: "Windows 10/11" });
      if (path === "/api/admin/workstations/printing-mode" && options?.method === "PUT") {
        putCalls.push(JSON.parse(String(options.body)));
        printingModeResponse = "LOGIN_AWARE";
        return response({ printingMode: "LOGIN_AWARE" });
      }
      throw new Error(`Unexpected request ${input}`);
    });
    await mount();
    expect(host.textContent).toContain("Prema prijavljenom korisniku");
    expect(host.textContent).toContain("Centralno rutiranje");

    await act(async () => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Prema prijavljenom korisniku"));
      button!.click();
    });
    expect(putCalls).toEqual([{ printingMode: "LOGIN_AWARE" }]);
  });

  it("changing printing mode requires confirmation — a cancelled confirm() never calls the API", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    await mount();
    await act(async () => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Prema prijavljenom korisniku"));
      button!.click();
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("printing-mode"))).toBe(false);
  });

  it("under LOGIN_AWARE, a workstation with a bound terminal session shows its current operational role", async () => {
    printingModeResponse = "LOGIN_AWARE";
    workstationsResponse = [
      workstation({
        lastSeenAt: new Date().toISOString(),
        terminalSession: { printRole: "KITCHEN", employeeId: "emp-1", expiresAt: new Date(Date.now() + 60000).toISOString() },
      }),
    ];
    await mount();
    expect(host.textContent).toContain("Trenutna operativna uloga:");
    expect(host.textContent).toContain("Kuhinja");
  });

  it("the 'Glavna' primary toggle is hidden with only one workstation, and shown once a second workstation shares the same enabled route type", async () => {
    workstationsResponse = [
      workstation({ id: "ws-1", name: "PC1", lastSeenAt: new Date().toISOString(), printRoutes: [route("KITCHEN", { printerName: "POS-58", printerAvailable: true })] }),
    ];
    await mount();
    expect(host.textContent).not.toContain("Glavna ruta");

    workstationsResponse = [
      workstation({ id: "ws-1", name: "PC1", lastSeenAt: new Date().toISOString(), printRoutes: [route("KITCHEN", { printerName: "POS-58", printerAvailable: true })] }),
      workstation({ id: "ws-2", name: "PC2", locationId: "l1", lastSeenAt: new Date().toISOString(), printRoutes: [route("KITCHEN", { printerName: "Printer-2", printerAvailable: true })] }),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(host.textContent).toContain("Glavna ruta");
  });
});

// BUG #2 (Admin → Printers → Sačuvaj rute dirty-state UX) — the Save
// button must reflect whether the operator has actually changed any
// setting. Initial load = clean + disabled + "Sačuvano" indicator. After
// any field change = dirty + enabled + indicator hidden. After revert =
// clean again. After successful save = clean again, persisted baseline
// updates. The button label is now restaurant-facing ("Sačuvaj
// podešavanja") not infrastructure terminology ("Sačuvaj rute"). Bug #1
// (physicalTestConfirmed) lifecycle is unaffected and not asserted here.
describe("WorkstationsPanel — Printers Save button reflects dirty state (BUG #2)", () => {
  function findSaveButton(): HTMLButtonElement | undefined {
    return [...host.querySelectorAll("button")].find((b) => b.textContent === "Sačuvaj podešavanja") as HTMLButtonElement | undefined;
  }

  it("initial load with already-configured routes shows 'Sačuvano' and a disabled 'Sačuvaj podešavanja' button", async () => {
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
    const btn = findSaveButton();
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(true);
    expect(host.textContent).toContain("Sačuvano");
    // The legacy infrastructure label must NOT appear anywhere.
    expect(host.textContent).not.toContain("Sačuvaj rute");
  });

  it("changing a setting enables Save and hides 'Sačuvano' (DIRTY state)", async () => {
    workstationsResponse = [
      workstation({
        lastSeenAt: new Date().toISOString(),
        availablePrinters: ["POS-58", "Microsoft Print to PDF"],
        printRoutes: [route("KITCHEN", { printerName: "POS-58", printerAvailable: true, paperWidthMm: 58 })],
      }),
    ];
    await mount();
    expect(findSaveButton()!.disabled).toBe(true);
    expect(host.textContent).toContain("Sačuvano");

    // Operator changes the KITCHEN route's printerName from POS-58 to
    // the Microsoft Print to PDF option.
    await act(async () => {
      const selects = [...host.querySelectorAll("select")].filter((s) =>
        [...s.options].some((o) => o.value === "Microsoft Print to PDF"),
      );
      const target = selects[0] as HTMLSelectElement;
      target.value = "Microsoft Print to PDF";
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const btn = findSaveButton();
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(false);
    // 'Sačuvano' indicator must disappear while the form is dirty.
    expect(host.textContent).not.toContain("Sačuvano");
  });

  it("reverting a change back to its original persisted value disables Save again (REVERT → SAVED)", async () => {
    workstationsResponse = [
      workstation({
        lastSeenAt: new Date().toISOString(),
        availablePrinters: ["POS-58", "Microsoft Print to PDF"],
        printRoutes: [route("KITCHEN", { printerName: "POS-58", printerAvailable: true, paperWidthMm: 58 })],
      }),
    ];
    await mount();
    expect(findSaveButton()!.disabled).toBe(true);

    // Change → revert → expect clean again.
    await act(async () => {
      const selects = [...host.querySelectorAll("select")].filter((s) =>
        [...s.options].some((o) => o.value === "Microsoft Print to PDF"),
      );
      const target = selects[0] as HTMLSelectElement;
      target.value = "Microsoft Print to PDF";
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(findSaveButton()!.disabled).toBe(false);

    await act(async () => {
      const selects = [...host.querySelectorAll("select")].filter((s) =>
        [...s.options].some((o) => o.value === "Microsoft Print to PDF"),
      );
      const target = selects[0] as HTMLSelectElement;
      target.value = "POS-58";
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(findSaveButton()!.disabled).toBe(true);
    expect(host.textContent).toContain("Sačuvano");
  });

  it("after a successful save, Save is disabled again and 'Sačuvano' reappears (no duplicate save)", async () => {
    workstationsResponse = [
      workstation({
        lastSeenAt: new Date().toISOString(),
        availablePrinters: ["POS-58"],
        printRoutes: [route("KITCHEN", { printerName: "POS-58", printerAvailable: true, paperWidthMm: 58 })],
      }),
    ];
    const putCalls: string[] = [];
    fetchMock.mockImplementation(async (input: string, options?: RequestInit) => {
      const path = String(input).split("?")[0];
      if (path === "/api/admin/workstations") return response({ workstations: workstationsResponse, pendingPairings: [] });
      if ( path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.2", supportedOS: "Windows 10/11" });
      if (path.includes("/routes/") && options?.method === "PUT") { putCalls.push(path); return response({ route: {} }); }
      throw new Error(`Unexpected request ${input}`);
    });
    await mount();
    expect(findSaveButton()!.disabled).toBe(true);

    // Operator changes paperWidthMm on KITCHEN route.
    await act(async () => {
      const selects = [...host.querySelectorAll("select")];
      // The paperWidthMm select is the one whose options include 58 and 80.
      const target = selects.find((s) => {
        const opts = [...s.options].map((o) => o.value);
        return opts.includes("58") && opts.includes("80");
      }) as HTMLSelectElement;
      target.value = "80";
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(findSaveButton()!.disabled).toBe(false);

    // Save → expect PUT for KITCHEN at minimum, then back to clean state.
    await act(async () => {
      findSaveButton()!.click();
    });
    expect(putCalls.some((p) => p.endsWith("/routes/KITCHEN"))).toBe(true);

    // The form must return to the saved state — Save disabled + indicator visible.
    expect(findSaveButton()!.disabled).toBe(true);
    expect(host.textContent).toContain("Sačuvano");
    // The legacy infrastructure label must never reappear.
    expect(host.textContent).not.toContain("Sačuvaj rute");
  });
});
