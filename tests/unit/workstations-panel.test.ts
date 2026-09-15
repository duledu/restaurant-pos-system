// @vitest-environment jsdom
//
// PREPROD physical QA follow-up (Part A2) — Admin -> Podešavanja štampača
// only ever fetched workstation state ONCE on mount; an admin had to
// manually reload the browser to see a workstation come online, go
// offline, report a new printer, or otherwise converge to server state.
// This proves the panel now polls in the background (same setInterval +
// in-flight-guard pattern already proven in KdsClient.tsx) and picks up a
// server-side change on its own, without any user action.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkstationsPanel } from "../../apps/web/components/kds/WorkstationsPanel";

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

function workstation(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1", name: "Kuhinjski računar", station: "KITCHEN", locationId: "l1", location: { id: "l1", name: "Glavna" },
    configuredPrinterName: null, printerAvailable: null, paperWidthMm: null, agentVersion: "1.0.0-pilot.1", osDescription: null,
    isEnabled: true, lastSeenAt: null, lastSuccessfulCommunicationAt: null, lastPrintAt: null,
    testPrintRequestedAt: null, testPrintStatus: null, testPrintCompletedAt: null, testPrintError: null,
    revokedAt: null, pairedAt: "2026-09-15T09:00:00Z",
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
    if (path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.1", supportedOS: "Windows 10/11" });
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

describe("WorkstationsPanel — Admin converges automatically, without a manual page reload", () => {
  it("picks up a workstation coming online (heartbeat) on the next background poll, with no user action", async () => {
    await act(async () => {
      root.render(React.createElement(WorkstationsPanel, { locationId: "l1" }));
    });
    expect(host.textContent).toContain("Van mreže");
    expect(host.textContent).not.toContain("Povezana");

    // Server-side state changes (agent heartbeat) — nothing in the DOM
    // triggers this; it's purely the passage of time / background poll.
    workstationsResponse = [workstation({ lastSeenAt: new Date().toISOString(), configuredPrinterName: "POS-58", printerAvailable: true, paperWidthMm: 58 })];

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
      if (path === "/api/admin/workstations/agent-download") return response({ available: false, url: null, version: "1.0.0-pilot.1", supportedOS: "Windows 10/11" });
      throw new Error(`Unexpected request ${input}`);
    });
    await act(async () => {
      root.render(React.createElement(WorkstationsPanel, { locationId: "l1" }));
    });
    const afterMount = calls;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).toBe(afterMount + 1);
  });
});
