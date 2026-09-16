// @vitest-environment jsdom
//
// PRINTING V2 FINAL — LOGIN_AWARE terminal binding, browser side. Proves:
// (1) the primary action is available from the normal "idle" starting
// state (a real regression caught while writing this test — hiding the
// button during "idle" made it impossible to ever click), (2) clicking it
// is a real user-gesture navigation of the SAME custom URI scheme already
// proven for Admin pairing (tablecore-print://), never automatic, (3) it
// converges to "bound" purely by polling its OWN authenticated status
// endpoint (never trusting anything the Agent asserts back to the browser
// directly), and (4) it renders nothing once the server has confirmed
// (via a real attempt) that this login has no operational print role.
import React, { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalBindingBadge } from "../../apps/web/components/ui/TerminalBindingBadge";

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(h(TerminalBindingBadge));
  });
}

describe("TerminalBindingBadge", () => {
  it("shows 'Poveži ovaj računar' from the normal idle starting state (not hidden until a bind is actually attempted)", async () => {
    fetchMock = vi.fn(async (input: string) => {
      if (String(input) === "/api/pos/terminal/status") return response({ status: null });
      throw new Error(`Unexpected request ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Poveži ovaj računar"));
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(false);
  });

  it("renders nothing once the server confirms (via a real bind attempt) this login has no operational print role", async () => {
    fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/pos/terminal/status") return response({ status: null });
      if (path === "/api/pos/terminal/bind-intent" && options?.method === "POST") return response({ intent: null });
      throw new Error(`Unexpected request ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await act(async () => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Poveži ovaj računar"));
      button!.click();
    });
    expect(host.textContent).toBe("");
    expect(host.querySelector("button")).toBeNull();
  });

  it("clicking navigates the SAME tablecore-print:// scheme as Admin pairing (never auto-fired) and converges to 'bound' by polling status, not by trusting the Agent directly", async () => {
    let statusCalls = 0;
    fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/pos/terminal/status") {
        statusCalls++;
        // Bound only from the 3rd status check onward — proves this is a
        // real poll loop, not a single optimistic assumption of success.
        if (statusCalls >= 3) {
          return response({ status: { workstationId: "ws-1", printRole: "KITCHEN", expiresAt: new Date(Date.now() + 60000).toISOString() } });
        }
        return response({ status: null });
      }
      if (path === "/api/pos/terminal/bind-intent" && options?.method === "POST") {
        return response({ intent: { token: "test-token-123", printRole: "KITCHEN", expiresAt: new Date(Date.now() + 120000).toISOString() } });
      }
      throw new Error(`Unexpected request ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    let assignedHref: string | undefined;
    Object.defineProperty(window, "location", {
      value: { ...window.location, set href(v: string) { assignedHref = v; }, get href() { return assignedHref ?? ""; } },
      writable: true,
    });

    await mount();
    expect(assignedHref).toBeUndefined(); // never navigates automatically on mount

    await act(async () => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Poveži ovaj računar"));
      button!.click();
      await Promise.resolve(); // let the bind-intent fetch resolve before asserting the navigation
      await Promise.resolve();
    });
    expect(assignedHref).toBe("tablecore-print://bind?token=test-token-123");
    expect(host.textContent).toContain("Povezivanje…");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500 * 3);
    });
    expect(host.textContent).toContain("Radna stanica: KUHINJA");
    expect(host.querySelector("button")).toBeNull(); // bound state shows status text only, no action button
  });

  it("shows a retry action and error message if the Agent round trip never completes", async () => {
    fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/pos/terminal/status") return response({ status: null }); // never confirms
      if (path === "/api/pos/terminal/bind-intent" && options?.method === "POST") {
        return response({ intent: { token: "t", printRole: "KITCHEN", expiresAt: new Date(Date.now() + 120000).toISOString() } });
      }
      throw new Error(`Unexpected request ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "location", { value: { ...window.location, set href(_v: string) {} }, writable: true });

    await mount();
    await act(async () => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Poveži ovaj računar"));
      button!.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500 * 41); // exceed the ~60s poll window
    });
    expect(host.textContent).toContain("Poveži ovaj računar (pokušaj ponovo)");
    expect(host.textContent).toMatch(/Povezivanje nije potvrđeno/);
  });
});
