import { afterEach, describe, expect, it, vi } from "vitest";
import { printAndConfirm } from "../../apps/web/lib/print-client";

afterEach(() => vi.unstubAllGlobals());
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("print client attempt protocol", () => {
  it("claims and receives one-shot start permission before invoking transport", async () => {
    const events: string[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      events.push(url.split("/").pop()!);
      if (url.endsWith("/begin")) {
        expect(init.headers).toEqual({ "X-TableCore-Print-Protocol": "2" });
        return response({ printJob: { attemptId: "attempt" } });
      }
      expect(JSON.parse(init.body as string).attemptId).toBe("attempt");
      return response({ printJob: {} });
    });
    vi.stubGlobal("fetch", fetcher);
    await printAndConfirm("order", "job", { print: async () => { events.push("transport"); } });
    expect(events).toEqual(["begin", "start", "transport", "confirm"]);
    expect(JSON.parse(fetcher.mock.calls[2][1].body as string).outcome).toBe("TRANSPORT_COMPLETED");
  });
  it("does not invoke transport when claim or start is denied", async () => {
    const print = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => response({}, 409)));
    await expect(printAndConfirm("order", "job", { print })).rejects.toThrow();
    await expect(printAndConfirm("order", "job", { print }, "attempt")).rejects.toThrow();
    expect(print).not.toHaveBeenCalled();
  });
  it("does not report failure when a success acknowledgement is lost", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ printJob: {} })).mockRejectedValueOnce(new Error("network lost"));
    vi.stubGlobal("fetch", fetcher);
    const print = vi.fn(async () => {});
    await expect(printAndConfirm("order", "job", { print }, "attempt")).rejects.toThrow("network lost");
    expect(print).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).outcome).toBe("TRANSPORT_COMPLETED");
  });
  it.each([['Error', 'SUBMISSION_UNKNOWN'], ['QzPrinterNotFoundError', 'FAILED_BEFORE_SUBMISSION']] as const)("classifies %s conservatively", async (name, outcome) => {
    const fetcher = vi.fn(async () => response({ printJob: {} }));
    vi.stubGlobal("fetch", fetcher);
    const error = new Error("printer problem"); error.name = name;
    await expect(printAndConfirm("order", "job", { print: async () => { throw error; } }, "attempt")).rejects.toThrow();
    expect(JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[1][1].body as string).outcome).toBe(outcome);
  });
  it("never invokes transport twice when the same claimed attempt is reused", async () => {
    let started = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/start")) {
        if (started) return response({}, 400);
        started = true;
      }
      return response({ printJob: {} });
    }));
    const print = vi.fn(async () => {});
    await printAndConfirm("order", "job", { print }, "attempt");
    await expect(printAndConfirm("order", "job", { print }, "attempt")).rejects.toThrow();
    expect(print).toHaveBeenCalledTimes(1);
  });
});
