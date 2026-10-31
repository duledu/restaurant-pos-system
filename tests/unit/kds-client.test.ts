// @vitest-environment jsdom
//
// PREPROD physical QA follow-up — real-device Kitchen tracing proved a
// structural race in KdsClient.tsx's load()/advance() interaction: a
// polling GET issued BEFORE a tap could resolve AFTER that tap's
// optimistic+confirmed update and silently revert the item, which is what
// produced the physical QA video's mixed-status screen and the
// "Status stavke je već promenjen — osveži prikaz" report while other
// items showed unrelated statuses. These tests reproduce that exact
// out-of-order-response race with controlled (deferred) fetch responses
// and prove the sequence-guarded merge fixes it, without weakening the
// backend's stale-status guard (production-service.ts StaleItemStatusError
// still throws — see production-service.test-adjacent coverage in
// print-auto-dispatch.test.ts's sibling suites for the domain layer).
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KdsClient } from "../../apps/web/components/kds/KdsClient";
import { clearClientCache } from "../../apps/web/lib/client-cache";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function response(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as Response;
}

const baseItem = { id: "item-1", name: "Pljeskavica", quantity: 1, note: null, status: "SUBMITTED", modifiers: [], submittedAt: "2026-09-15T10:00:00Z" };
const secondItem = { id: "item-2", name: "Sarma", quantity: 1, note: null, status: "SUBMITTED", modifiers: [], submittedAt: "2026-09-15T10:00:00Z" };
function order(items = [baseItem]) {
  return { orderId: "order-1", tableLabel: "Sto 5", waiterName: "Ana", submittedAt: "2026-09-15T10:00:00Z", items };
}
const emptyPrintJobs = { jobs: [], autoPrintEligible: false, agentActiveForStation: false, printerStatus: { hasWorkstation: false, isOnline: false, state: "NOT_CONFIGURED" }, hasRecentFailure: false };

let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let custom: (url: string, options?: RequestInit) => Response | Promise<Response> | undefined;

beforeEach(() => {
  clearClientCache();
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // requestAnimationFrame's real ~16ms-per-frame timing has no place in a
  // unit test — resolving it via a microtask keeps the double-rAF paint
  // proof (see kds-perf.ts) fast and deterministic without changing what
  // it proves (only DOM behavior; this does not measure browser painting).
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queueMicrotask(() => cb(performance.now()));
    return 0;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  custom = () => undefined;
  fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
    const url = String(input);
    const result = custom(url, options);
    if (result) return result;
    if (url.includes("/advance?")) return response({ item: baseItem });
    const path = url.split("?")[0];
    if (path === "/api/pos/me") return response({ restaurantId: "r1", employeeId: "e1", firstName: "Marko", lastName: "Petrović", roles: ["KITCHEN"], locationIds: ["l1"] });
    if (path === "/api/production/kitchen") return response({ orders: [order()] });
    if (path === "/api/production/kitchen/completed") return response({ orders: [] });
    if (path === "/api/production/kitchen/print-jobs") return response(emptyPrintJobs);
    if (path === "/api/production/items/order-1/item-1/advance") return response({ item: { ...baseItem, status: "ACCEPTED" } });
    throw new Error(`Unexpected request ${url}`);
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
    root.render(React.createElement(KdsClient, { station: "KITCHEN", title: "Kuhinja", environmentLabel: "TEST" }));
  });
}
/** Drains every pending microtask hop (fire-and-forget advance()->load()
 * chains are several .then/await deep) via a real macrotask boundary,
 * then lets React flush the resulting state updates. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
function findButton(text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}
async function click(text: string) {
  await act(async () => {
    findButton(text).click();
  });
}

describe("KDS independent resource loading", () => {
  it("shows and refreshes active tickets while history and printing remain pending", async () => {
    vi.useFakeTimers();
    const history = deferred<Response>();
    const printing = deferred<Response>();
    custom = url => url.includes("/completed") ? history.promise : url.includes("/print-jobs") ? printing.promise : undefined;
    await mount();
    expect(host.textContent).toContain("Pljeskavica");
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/production/kitchen?locationId=l1")).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/completed"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/print-jobs"))).toHaveLength(1);
    await act(async () => { history.resolve(response({ orders: [] })); printing.resolve(response(emptyPrintJobs)); });
  });

  it("keeps history/print failures visible when active requests succeed and clears each after recovery", async () => {
    vi.useFakeTimers();
    custom = url => url.includes("/completed") ? response({ error: "history unavailable" }, false)
      : url.includes("/print-jobs") ? response({ error: "printer unavailable" }, false) : undefined;
    await mount();
    expect(host.textContent).toContain("Pljeskavica");
    expect(host.textContent).toContain("history unavailable");
    expect(host.textContent).toContain("printer unavailable");
    custom = url => url.includes("/completed") ? response({ error: "history unavailable" }, false) : undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(host.textContent).toContain("history unavailable");
    expect(host.textContent).not.toContain("printer unavailable");
  });

  it("shows active request errors without suppressing completed history", async () => {
    custom = url => url === "/api/production/kitchen?locationId=l1" ? response({ error: "active unavailable" }, false)
      : url.includes("/completed") ? response({ orders: [{ ...order([{ ...baseItem, status: "READY" }]), completedAt: baseItem.submittedAt }] }) : undefined;
    await mount();
    expect(host.textContent).toContain("active unavailable");
    await click("Gotove");
    expect(host.textContent).toContain("Pljeskavica");
  });

  it("does not queue print work from a response arriving after unmount", async () => {
    const printing = deferred<Response>();
    custom = url => url.includes("/print-jobs") ? printing.promise : undefined;
    await mount();
    await act(async () => root.render(null));
    const count = fetchMock.mock.calls.length;
    await act(async () => printing.resolve(response({ ...emptyPrintJobs, autoPrintEligible: true, jobs: [{ id: "job", orderId: "order-1", status: "PENDING", isAutomatic: true }] })));
    expect(fetchMock.mock.calls).toHaveLength(count);
  });
});

describe("KdsClient — instant optimistic Kitchen transitions", () => {
  it.each(["ACCEPTED", "PREPARING"])("shows READY pending immediately from %s and keeps the ticket until confirmation", async status => {
    const gate = deferred<Response>();
    custom = url => url.endsWith("/advance") ? gate.promise : url === "/api/production/kitchen?locationId=l1"
      ? response({ orders: [order([{ ...baseItem, status }])] }) : undefined;
    await mount();
    const initialRequests = fetchMock.mock.calls.length;
    await click("Označi spremno");
    expect(host.textContent).toContain("Spremno");
    expect(host.textContent).toContain("Čeka potvrdu");
    expect(host.textContent).toContain("Sto 5");
    expect(fetchMock.mock.calls.length - initialRequests).toBe(1);
    await act(async () => gate.resolve(response({ item: { status: "READY" } })));
    expect(host.textContent).not.toContain("Sto 5");
    expect(host.textContent).not.toContain("Čeka potvrdu");
    expect(fetchMock.mock.calls.length - initialRequests).toBe(1);
  });

  it("does not wait for diagnostic animation frames before enabling the confirmed next action", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    await mount();
    await click("Prihvati");
    expect(findButton("Označi spremno").disabled).toBe(false);
  });

  it("rolls back failed READY even while the board poll and history are still pending", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const poll = deferred<Response>();
    custom = url => url === "/api/production/kitchen?locationId=l1" ? response({ orders: [order([{ ...baseItem, status: "ACCEPTED" }])] }) : undefined;
    await mount();
    custom = url => url.endsWith("/advance") ? response({ error: "Nije sačuvano" }, false, 500)
      : url.includes("/advance?") ? response({ item: { status: "ACCEPTED" } })
      : url.includes("locationId") ? poll.promise : undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    const before = fetchMock.mock.calls.length;
    await click("Označi spremno");
    expect(fetchMock.mock.calls.slice(before).map(([url]) => url)).toEqual([
      "/api/production/items/order-1/item-1/advance", "/api/production/items/order-1/item-1/advance?station=KITCHEN",
    ]);
    expect(host.textContent).toContain("Nije sačuvano");
    expect(host.textContent).toContain("U pripremi");
    expect(findButton("Označi spremno").disabled).toBe(false);
  });

  it("times out a lost POST response, reconciles its committed state, and never repeats the POST", async () => {
    vi.useFakeTimers();
    custom = (url, options) => {
      if (url.endsWith("/advance")) return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
      });
      if (url.includes("/advance?")) return response({ item: { status: "ACCEPTED" } });
      return undefined;
    };
    await mount();
    await click("Prihvati");
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(host.textContent).toContain("U pripremi");
    expect(host.textContent).not.toContain("Čeka potvrdu");
    expect(findButton("Označi spremno").disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it("keeps an ambiguous action disabled until a later targeted read succeeds", async () => {
    vi.useFakeTimers();
    let available = false;
    custom = url => url.endsWith("/advance") ? Promise.reject(new Error("Connection lost"))
      : url.includes("/advance?") ? available ? response({ item: { status: "SUBMITTED" } }) : response({}, false, 503) : undefined;
    await mount();
    await click("Prihvati");
    expect(host.textContent).toContain("Provera statusa");
    expect(findButton("Označi spremno").disabled).toBe(true);
    available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(host.textContent).toContain("Novo");
    expect(findButton("Prihvati").disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it("treats a malformed successful response as unconfirmed and reconciles cancellation", async () => {
    custom = url => url.endsWith("/advance") ? response({})
      : url.includes("/advance?") ? response({ item: { status: "CANCELLED" } }) : undefined;
    await mount();
    await click("Prihvati");
    expect(host.textContent).toContain("Server nije potvrdio status");
    expect(host.textContent).not.toContain("Sto 5");
  });

  it("shows the new status immediately, before the server confirms (same tick as the click)", async () => {
    const advanceGate = deferred<Response>();
    custom = (url) => (url.endsWith("/advance") ? advanceGate.promise : undefined);
    await mount();
    expect(host.textContent).toContain("Novo");

    await click("Prihvati");
    // Optimistic update must be visible even though the POST is still pending.
    expect(host.textContent).toContain("U pripremi");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/advance"))).toHaveLength(1);

    advanceGate.resolve(response({ item: { ...baseItem, status: "ACCEPTED" } }));
    await flush();
    expect(host.textContent).toContain("U pripremi");
  });

  it("does not double-submit the same item on a rapid double tap while the first request is still pending", async () => {
    const advanceGate = deferred<Response>();
    custom = (url) => (url.endsWith("/advance") ? advanceGate.promise : undefined);
    await mount();

    const button = findButton("Prihvati");
    await act(async () => {
      button.click();
      button.click(); // second tap before the first request resolves
    });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/advance"))).toHaveLength(1);

    advanceGate.resolve(response({ item: { ...baseItem, status: "ACCEPTED" } }));
    await flush();
    expect(host.textContent).toContain("U pripremi");
  });

  it("advances two different items independently — one pending item never blocks another", async () => {
    custom = (url) => {
      if (url === "/api/production/kitchen?locationId=l1") return response({ orders: [order([baseItem, secondItem])] });
      return undefined;
    };
    await mount();
    expect(host.textContent).toContain("Pljeskavica");
    expect(host.textContent).toContain("Sarma");

    const gate1 = deferred<Response>();
    const gate2 = deferred<Response>();
    custom = (url) => {
      if (url === "/api/production/kitchen?locationId=l1") return response({ orders: [order([baseItem, secondItem])] });
      if (url.endsWith("/item-1/advance")) return gate1.promise;
      if (url.endsWith("/item-2/advance")) return gate2.promise;
      return undefined;
    };
    const buttons = [...host.querySelectorAll("button")].filter((b) => b.textContent?.includes("Prihvati"));
    expect(buttons).toHaveLength(2);
    await act(async () => {
      buttons[0].click();
      buttons[1].click();
    });
    // Both items reflect the optimistic transition independently, while
    // BOTH their requests are still in flight — neither waited on the other.
    const acceptedCount = (host.textContent?.match(/U pripremi/g) ?? []).length;
    expect(acceptedCount).toBe(2);

    gate1.resolve(response({ item: { ...baseItem, status: "ACCEPTED" } }));
    gate2.resolve(response({ item: { ...secondItem, status: "ACCEPTED" } }));
    await flush();
  });
});

describe("KdsClient — out-of-order poll responses must never regress a newer local state (root cause of the physical QA report)", () => {
  it("removes another terminal's READY item when the remaining sibling objects are unchanged", async () => {
    vi.useFakeTimers();
    custom = url => url === "/api/production/kitchen?locationId=l1" ? response({ orders: [order([{ ...baseItem, status: "ACCEPTED" }, secondItem])] }) : undefined;
    await mount();
    custom = url => url === "/api/production/kitchen?locationId=l1" ? response({ orders: [order([secondItem])] }) : undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(host.textContent).not.toContain("Pljeskavica");
    expect(host.textContent).toContain("Sarma");
    expect(host.textContent).not.toContain("Označi spremno");
  });

  it.each([false, true])("protects a poll started DURING a mutation, resolving after confirmation=%s", async afterConfirmation => {
    vi.useFakeTimers();
    const mutation = deferred<Response>();
    const poll = deferred<Response>();
    await mount();
    custom = url => url.endsWith("/advance") ? mutation.promise
      : url === "/api/production/kitchen?locationId=l1" ? poll.promise : undefined;
    await click("Prihvati");
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    if (afterConfirmation) await act(async () => mutation.resolve(response({ item: { status: "ACCEPTED" } })));
    await act(async () => poll.resolve(response({ orders: [order()] })));
    expect(host.textContent).toContain("U pripremi");
    expect(host.textContent).not.toContain("Novo");
    if (!afterConfirmation) {
      expect(host.textContent).toContain("Čeka potvrdu");
      await act(async () => mutation.resolve(response({ item: { status: "ACCEPTED" } })));
    }
  });

  it("does not resurrect a confirmed READY ticket from a stale active-list response", async () => {
    vi.useFakeTimers();
    custom = url => url === "/api/production/kitchen?locationId=l1" ? response({ orders: [order([{ ...baseItem, status: "ACCEPTED" }])] }) : undefined;
    await mount();
    const poll = deferred<Response>();
    custom = url => url === "/api/production/kitchen?locationId=l1" ? poll.promise
      : url.endsWith("/advance") ? response({ item: { status: "READY" } }) : undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await click("Označi spremno");
    await act(async () => poll.resolve(response({ orders: [order([{ ...baseItem, status: "ACCEPTED" }])] })));
    expect(host.textContent).not.toContain("Sto 5");
  });

  it("preserves pending READY when polls omit that item, without retaining removed siblings", async () => {
    vi.useFakeTimers();
    custom = url => url === "/api/production/kitchen?locationId=l1" ? response({ orders: [order([{ ...baseItem, status: "ACCEPTED" }, secondItem])] }) : undefined;
    await mount();
    const gate = deferred<Response>();
    custom = url => url.endsWith("/advance") ? gate.promise
      : url === "/api/production/kitchen?locationId=l1" ? response({ orders: [] }) : undefined;
    await click("Označi spremno");
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(host.textContent).toContain("Spremno");
    expect(host.textContent).toContain("Čeka potvrdu");
    expect(host.textContent).not.toContain("Sarma");
    await act(async () => gate.resolve(response({ item: { status: "READY" } })));
    expect(host.textContent).not.toContain("Sto 5");
  });
  it("a poll GET issued before a tap does not revert that item when it resolves after the tap's confirmed update", async () => {
    // Only fake the interval timer — React's own scheduling (and this
    // file's flush() helper) rely on real setTimeout/microtasks, which
    // must keep working normally or act()/effects can hang indefinitely.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let pollCalls = 0;
    const slowPoll = deferred<Response>();
    custom = (url) => {
      if (url === "/api/production/kitchen?locationId=l1") {
        pollCalls += 1;
        return pollCalls === 1 ? response({ orders: [order()] }) : slowPoll.promise;
      }
      return undefined;
    };
    await mount();
    expect(host.textContent).toContain("Novo");

    // Trigger the interval poll — it "starts" now (captures its sequence
    // number) but hangs, simulating a slow/cold-start network round-trip
    // exactly like the physical QA environment.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(pollCalls).toBe(2);

    // Tap happens AFTER the slow poll started, and its own request
    // resolves fast (typical real-world ordering that produced the bug).
    custom = (url) => {
      if (url === "/api/production/kitchen?locationId=l1") return slowPoll.promise;
      if (url.endsWith("/advance")) return response({ item: { ...baseItem, status: "ACCEPTED" } });
      return undefined;
    };
    await click("Prihvati");
    await flush();
    expect(host.textContent).toContain("U pripremi");

    // The stale poll (issued BEFORE the tap) now finally resolves, still
    // carrying the OLD pre-tap status. It must NOT win.
    await act(async () => {
      slowPoll.resolve(response({ orders: [order()] }));
    });
    await flush();
    expect(host.textContent).toContain("U pripremi");
    expect(host.textContent).not.toContain("Novo");
  });
});

describe("KdsClient — stale-status conflicts recover automatically (no 'refresh the page')", () => {
  it("a 409 stale-status response reconciles silently to the authoritative state, with no error banner", async () => {
    await mount();
    custom = (url) => {
      if (url.endsWith("/advance")) return response({ error: "Status stavke je već promenjen — osveži prikaz" }, false, 409);
      if (url.includes("/advance?")) return response({ item: { ...baseItem, status: "ACCEPTED" } });
      // Authoritative reconcile fetch: someone/something else already moved it.
      if (url === "/api/production/kitchen?locationId=l1") return response({ orders: [order([{ ...baseItem, status: "ACCEPTED" }])] });
      return undefined;
    };
    await click("Prihvati");
    await flush();

    expect(host.textContent).not.toContain("osveži prikaz");
    expect(host.textContent).not.toContain("Status stavke je već promenjen");
    expect(host.textContent).toContain("U pripremi");
  });

  it("a genuine failure (non-409) still reconciles automatically but does surface an actionable error", async () => {
    await mount();
    custom = (url) => {
      if (url.endsWith("/advance")) return response({ error: "Mrežna greška" }, false, 500);
      if (url === "/api/production/kitchen?locationId=l1") return response({ orders: [order()] });
      return undefined;
    };
    await click("Prihvati");
    await flush();

    expect(host.textContent).toContain("Mrežna greška");
    // Reconciled back to the server's authoritative (unchanged) status —
    // never left showing the now-known-wrong optimistic guess.
    expect(host.textContent).toContain("Novo");
  });

  it("a genuine failure on one item never regresses a different item that changed via poll in the meantime", async () => {
    custom = (url) => (url === "/api/production/kitchen?locationId=l1" ? response({ orders: [order([baseItem, secondItem])] }) : undefined);
    await mount();
    expect(host.textContent).toContain("Sarma");

    const advanceGate = deferred<Response>();
    custom = (url) => {
      if (url === "/api/production/kitchen?locationId=l1") return response({ orders: [order([baseItem, secondItem])] });
      if (url.endsWith("/item-1/advance")) return advanceGate.promise;
      return undefined;
    };
    const button1 = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Prihvati"));
    await act(async () => { button1?.click(); });

    advanceGate.resolve(response({ error: "Mrežna greška" }, false, 500));
    await flush();
    expect(host.textContent).toContain("Mrežna greška");
  });
});

describe("KdsClient — Aktivne/Gotove", () => {
  it("removes an order from Aktivne immediately once its last pending item reaches a terminal status, without waiting for the next poll", async () => {
    custom = (url) => {
      if (url === "/api/production/kitchen?locationId=l1") return response({ orders: [order([{ ...baseItem, status: "ACCEPTED" }])] });
      if (url.endsWith("/advance")) return response({ item: { ...baseItem, status: "READY" } });
      return undefined;
    };
    await mount();
    expect(host.textContent).toContain("Sto 5");

    await click("Označi spremno");
    await flush();
    // READY has no further Kitchen action and is not a pending status —
    // the order must disappear from Aktivne right away (optimistic),
    // matching the server-side PENDING_PRODUCTION_STATUSES filter.
    expect(host.textContent).not.toContain("Sto 5");
  });
});

describe("KdsClient — 'Poslednja stampa nije uspela' recovers on its own, without a manual page refresh", () => {
  it("clears the warning on the next background poll once the server reports the printer is healthy again — no click, no reload", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let hasRecentFailure = true;
    custom = (url) => {
      if (url === "/api/production/kitchen/print-jobs?locationId=l1") {
        return response({ jobs: [], autoPrintEligible: false, agentActiveForStation: true, printerStatus: { hasWorkstation: true, isOnline: true, state: "READY" }, hasRecentFailure });
      }
      return undefined;
    };
    await mount();
    expect(host.textContent).toContain("Poslednja štampa nije uspela");

    // Nothing in the DOM triggers this — it's purely server-side recovery
    // (hasRecentPrintFailure now sees a later success) surfacing on the
    // KDS screen's own unchanged 4s background poll.
    hasRecentFailure = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(host.textContent).not.toContain("Poslednja štampa nije uspela");
    expect(host.textContent).toContain("Štampač spreman");
  });
});

describe("KdsClient — background polling cannot overlap itself", () => {
  it("skips an interval tick while the previous poll is still in flight, instead of piling up concurrent requests", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let activeCalls = 0;
    const slowPoll = deferred<Response>();
    custom = (url) => {
      if (url === "/api/production/kitchen?locationId=l1") {
        activeCalls += 1;
        return activeCalls === 1 ? slowPoll.promise : response({ orders: [order()] });
      }
      return undefined;
    };
    await mount();
    expect(activeCalls).toBe(1); // the initial mount load, still pending

    // The interval fires while that first load is still unresolved — the
    // loadInFlightRef guard must skip this tick entirely, not issue a
    // second overlapping request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(activeCalls).toBe(1);

    await act(async () => {
      slowPoll.resolve(response({ orders: [order()] }));
    });
    await flush();

    // Now that the first load has completed, the NEXT tick is free to run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(activeCalls).toBe(2);
  });
});

describe("KdsClient — logged-in employee identity (Part I/J)", () => {
  it("renders the authenticated employee's display name", async () => {
    custom = (url) =>
      url === "/api/pos/me" ? response({ restaurantId: "r1", employeeId: "e1", firstName: "Ana", lastName: "Anić", roles: ["KITCHEN"], locationIds: ["l1"] }) : undefined;
    await mount();
    expect(host.textContent).toContain("Ana Anić");
  });

  it("renders the role/station context alongside the name", async () => {
    custom = (url) =>
      url === "/api/pos/me" ? response({ restaurantId: "r1", employeeId: "e1", firstName: "Marko", lastName: "Petrović", roles: ["KITCHEN"], locationIds: ["l1"] }) : undefined;
    await mount();
    expect(host.textContent).toContain("KUHINJA");
  });

  it("a manager's OWNER/ADMIN/MANAGER role displays as a single, non-technical MENADŽER label", async () => {
    custom = (url) =>
      url === "/api/pos/me" ? response({ restaurantId: "r1", employeeId: "e1", firstName: "Iva", lastName: "Ivić", roles: ["MANAGER"], locationIds: ["l1"] }) : undefined;
    await mount();
    expect(host.textContent).toContain("Iva Ivić");
    expect(host.textContent).toContain("MENADŽER");
  });

  it("reflects whichever employee the current authenticated session belongs to — a different session shows a different name", async () => {
    custom = (url) =>
      url === "/api/pos/me" ? response({ restaurantId: "r1", employeeId: "e2", firstName: "Petar", lastName: "Perić", roles: ["BAR"], locationIds: ["l1"] }) : undefined;
    await mount();
    expect(host.textContent).toContain("Petar Perić");
    expect(host.textContent).not.toContain("Marko");
  });

  it("never renders sensitive session fields (employee id, PIN, tokens, email) even though they exist elsewhere in the session payload", async () => {
    custom = (url) =>
      url === "/api/pos/me"
        ? response({
            restaurantId: "r1",
            employeeId: "e1-super-secret-id",
            firstName: "Marko",
            lastName: "Petrović",
            roles: ["KITCHEN"],
            locationIds: ["l1"],
            // Fields a real /api/pos/me response does not currently send —
            // asserted absent regardless, so this stays a real regression
            // guard even if the route ever changes.
            email: "marko@example.com",
            pin: "1234",
            token: "should-never-render",
          })
        : undefined;
    await mount();
    expect(host.textContent).not.toContain("e1-super-secret-id");
    expect(host.textContent).not.toContain("marko@example.com");
    expect(host.textContent).not.toContain("1234");
    expect(host.textContent).not.toContain("should-never-render");
  });
});
