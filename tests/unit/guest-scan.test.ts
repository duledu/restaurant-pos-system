// @vitest-environment jsdom
import React, { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { GuestOrderScanner, diagnosticCode, type ImportScanResult } from "../../apps/web/app/waiter/tables/[tableId]/guest-scan";

let root: Root;
let host: HTMLDivElement;

function decode(token: string) {
  window.dispatchEvent(new CustomEvent("tablecore:test-qr-decode", { detail: token }));
}
function dialogText(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? "";
}
function click(text: string) {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not found in: ${dialogText()}`);
  btn.click();
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // CameraView's real getUserMedia path is irrelevant here — these tests
  // exercise everything AFTER decode (the actual production orchestration;
  // see guest-scan.tsx's test-decode event). A real camera can't run in
  // jsdom at all; stub it to hang forever so CameraView stays mounted
  // (phase "camera") with its decode listener attached, instead of
  // erroring out and unmounting before the test can dispatch a decode.
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: () => new Promise(() => {}) } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const SNAPSHOT = { itemCount: 2, totalPrice: "340.00", items: [{ menuItemId: "cola", name: "Coca-Cola", price: "170", quantity: 2, note: null, preparationStation: "BAR" as const }] };

describe("GuestOrderScanner — real orchestration via decode-bypass test hook", () => {
  it("camera -> resolving -> reviewing -> importing -> success (confirmed), and calls confirm-import", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("review")) return { ok: true, json: async () => SNAPSHOT };
      if (url.includes("claim")) return { ok: true, json: async () => SNAPSHOT };
      if (url.includes("confirm-import")) return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({}) };
    }));
    const onImport = vi.fn(async (): Promise<ImportScanResult> => ({ importedLines: 1, importedCount: 2, failedCount: 0, confirmed: true, correlationId: "test-id" }));

    await act(async () => root.render(h(GuestOrderScanner, { tableId: "table-1", onImport })));
    await act(async () => click("Skeniraj QR porudžbine"));
    expect(dialogText()).toContain("Skeniraj QR porudžbine"); // camera phase, no network yet
    await act(async () => decode("test-token"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(dialogText()).toContain("Porudžbina gosta");
    expect(dialogText()).toContain("Coca-Cola");

    await act(async () => click("DODAJ NA STO"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(onImport).toHaveBeenCalledWith(SNAPSHOT.items, expect.any(String));
    expect(dialogText()).toContain("Dodato na sto");
    expect(dialogText()).toContain("2 kom");
    expect(calls.some((u) => u.includes("confirm-import"))).toBe(true); // second half of acceptance ONLY fires on confirmed success
  });

  it("confirmed:false shows the honest recovery message with a diagnostic code, and never calls confirm-import", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("review") || url.includes("claim")) return { ok: true, json: async () => SNAPSHOT };
      return { ok: true, json: async () => ({}) };
    }));
    const onImport = vi.fn(async (): Promise<ImportScanResult> => ({ importedLines: 1, importedCount: 2, failedCount: 0, confirmed: false, correlationId: "abcd-1234-ef56" }));

    await act(async () => root.render(h(GuestOrderScanner, { tableId: "table-1", onImport })));
    await act(async () => click("Skeniraj QR porudžbine"));
    await act(async () => decode("test-token"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => click("DODAJ NA STO"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(dialogText()).toContain("Potvrda čuvanja nije stigla");
    expect(dialogText()).toContain(diagnosticCode("abcd-1234-ef56"));
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([u]: [string]) => u.includes("confirm-import"))).toBe(false);
  });

  it("a claim failure (e.g. already-claimed replay) shows a compact retryable error with a diagnostic code, never a silent success", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("review")) return { ok: true, json: async () => SNAPSHOT };
      if (url.includes("claim")) return { ok: false, status: 409, json: async () => ({ error: "Ova porudžbina je već preuzeta." }) };
      return { ok: true, json: async () => ({}) };
    }));
    const onImport = vi.fn();

    await act(async () => root.render(h(GuestOrderScanner, { tableId: "table-1", onImport })));
    await act(async () => click("Skeniraj QR porudžbine"));
    await act(async () => decode("test-token"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => click("DODAJ NA STO"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(onImport).not.toHaveBeenCalled(); // claim failed before import ever ran
    expect(dialogText()).toContain("Porudžbina nije dodata na sto");
    expect(dialogText()).toContain("već preuzeta");
    expect(dialogText()).toMatch(/Kod greške: QR-/);
    expect(dialogText()).toContain("POKUŠAJ PONOVO");
  });

  it("duplicate decode is ignored — only one review request fires even if the test hook fires twice", async () => {
    const reviewCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("review")) { reviewCalls.push(url); return { ok: true, json: async () => SNAPSHOT }; }
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => root.render(h(GuestOrderScanner, { tableId: "table-1", onImport: vi.fn() })));
    await act(async () => click("Skeniraj QR porudžbine"));
    await act(async () => { decode("token-a"); decode("token-b"); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(reviewCalls).toHaveLength(1);
  });
});

describe("diagnosticCode — short, waiter-reportable reference", () => {
  it("derives a stable 4-char code from a correlation id, never the raw id", () => {
    const code = diagnosticCode("f47ac10b-58cc-4372-a567-0e02b2c3d479");
    expect(code).toBe("QR-D479");
    expect(code).not.toContain("f47ac10b");
  });
});
