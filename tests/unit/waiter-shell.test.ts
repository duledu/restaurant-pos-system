// @vitest-environment jsdom
import React, { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WaiterShellProvider, useWaiterShell, type WaiterShellContextValue } from "../../apps/web/lib/waiter-shell";
import { PosClient } from "../../apps/web/app/waiter/tables/pos-client";
import { OrderClient } from "../../apps/web/app/waiter/tables/[tableId]/order-client";
import { readAvailability, mergeWaiterMenu } from "../../apps/web/lib/waiter-menu";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../apps/web/components/branding/AppLogo", () => ({ AppLogo: () => null }));
vi.mock("../../apps/web/components/ui/QuickLockButton", () => ({ QuickLockButton: () => null }));
vi.mock("../../apps/web/components/ui/LogoutButton", () => ({ LogoutButton: () => null }));

const menuItem = { id: "m1", name: "Coffee", price: "200", categoryId: "c1", modifierGroups: [] };
const menu = { restaurantId: "r1", locationId: "l1", menuVersion: 1, categories: [{ id: "c1", name: "Drinks", type: "DRINK" }], items: [menuItem] };
const overlay = { locationId: "l1", items: [{ menuItemId: "m1", stock: null, recipeAvailability: null, availability: { isAvailable: true, reasonCode: null, reasonLabel: null } }] };
const floors = [{ id: "f1", name: "Main", tables: ["5", "12"].map(id => ({ id, label: `Table ${id}`, status: "FREE", capacity: 4, activeOrderOwnerId: "e1", readyItems: [] })) }];
const line = { id: "i1", menuItemId: "m1", name: "Coffee", price: "200", quantity: 1, note: null, status: "DRAFT", modifiers: [] };
function order(id = "5") { return { id: `o${id}`, locationId: "l1", status: "SUBMITTED", table: { label: `Table ${id}` }, items: [{ ...line }] }; }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function response(body: unknown, ok = true) { return { ok, status: ok ? 200 : 500, json: async () => body } as Response; }
let root: Root;
let host: HTMLDivElement;
let shell: WaiterShellContextValue;
let fetchMock: ReturnType<typeof vi.fn>;
let custom: (url: string, options?: RequestInit) => Response | Promise<Response> | undefined;
let beep: ReturnType<typeof vi.fn>;
function Probe() { shell = useWaiterShell(); return h("span", { "data-probe": true }, shell.data.employeeId); }
async function render(child: React.ReactNode = h(Probe)) { await act(async () => { root.render(h(WaiterShellProvider, null, h(Probe), child)); }); }
function calls(path: string) { return fetchMock.mock.calls.filter(([url]) => String(url).split("?")[0] === path); }
async function click(text: string) { const button = [...host.querySelectorAll("button")].find(b => b.textContent?.includes(text)); expect(button).toBeTruthy(); await act(async () => { button!.click(); }); }
async function labelClick(label: string) { await act(async () => { host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(); }); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  custom = () => undefined;
  beep = vi.fn();
  vi.stubGlobal("AudioContext", class {
    currentTime = 0; destination = {};
    resume = async () => {}; close = async () => {};
    createOscillator = () => ({ frequency: { value: 0 }, connect: () => ({ connect: () => {} }), start: beep, stop: () => {} });
    createGain = () => ({ gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} } });
  });
  fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
    const url = String(input); const result = custom(url, options); if (result) return result;
    const path = url.split("?")[0];
    if (path === "/api/pos/me") return response({ restaurantId: "r1", employeeId: "e1", firstName: "Ana", lastName: "A", roles: ["WAITER"], locationIds: ["l1"] });
    if (path === "/api/pos/menu/snapshot") return response(menu);
    if (path === "/api/pos/menu/availability") return response(overlay);
    if (path === "/api/pos/shift") return response({ shift: { id: "s1", status: "OPEN" } });
    if (path === "/api/pos/tables") return response({ floors });
    if (path === "/api/pos/orders") return response({ order: order(JSON.parse(String(options?.body)).tableId) });
    if (/^\/api\/pos\/orders\/o(5|12)$/.test(path)) return response({ order: order(path.endsWith("12") ? "12" : "5") });
    if (path.endsWith("/submit")) return response({ order: order() });
    if (options?.method === "PATCH" || options?.method === "DELETE") return response({ ok: true });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("mounted persistent waiter shell", () => {
  it("gates children until complete preparation and prepares once across child navigation", async () => {
    const pending = deferred<Response>(); custom = url => url.includes("/snapshot") ? pending.promise : undefined;
    await render(); expect(host.querySelector("[data-probe]")).toBeNull();
    await act(async () => pending.resolve(response(menu)));
    expect(shell.data.restaurantId).toBe("r1"); expect(host.textContent).toContain("Smena je spremna");
    await render(h("div", null, "order route")); await render();
    expect(calls("/api/pos/me")).toHaveLength(1); expect(calls("/api/pos/menu/snapshot")).toHaveLength(1);
  });
  it("retry is safe after failure and duplicate clicks do not duplicate preparation", async () => {
    custom = url => url.includes("/availability") ? response({}, false) : undefined;
    await render(); expect(host.textContent).toContain("Ne možemo da završimo pripremu smene.");
    const pending = deferred<Response>(); custom = url => url === "/api/pos/me" ? pending.promise : undefined;
    const button = host.querySelector("button")!;
    await act(async () => { button.click(); button.click(); }); expect(calls("/api/pos/me")).toHaveLength(2);
    pending.resolve(response({ restaurantId: "r1", employeeId: "e2", roles: ["WAITER"], locationIds: ["l1"] }));
    await act(async () => {}); expect(shell.data.employeeId).toBe("e2");
  });
  it("rejects unknown availability during preparation", async () => {
    custom = url => url.includes("/availability") ? response({ locationId: "l1", items: [] }) : undefined;
    await render(); expect(host.querySelector("[data-probe]")).toBeNull(); expect(host.textContent).toContain("Pokušaj ponovo");
  });
  it.each([{}, { locationId: "l1", items: [] }, { ...overlay, locationId: "other" }])("retains authoritative map for incomplete successful refresh %j", async bad => {
    await render(); const previous = shell.data.availabilityByItemId;
    custom = url => url.includes("/availability") ? response(bad) : undefined;
    await act(async () => shell.refreshAvailability()); expect(shell.data.availabilityByItemId).toBe(previous);
  });
  it("deduplicates availability requests and changes only the overlay", async () => {
    await render(); const items = shell.data.items; const previousFloors = shell.data.floors;
    const pending = deferred<Response>(); custom = url => url.includes("/availability") ? pending.promise : undefined;
    const first = shell.refreshAvailability(); expect(shell.refreshAvailability()).toBe(first);
    expect(calls("/api/pos/menu/availability")).toHaveLength(2);
    await act(async () => { pending.resolve(response({ ...overlay, items: [{ ...overlay.items[0], availability: { isAvailable: false } }] })); await first; });
    expect(shell.data.availabilityByItemId.get("m1")?.availability?.isAvailable).toBe(false);
    expect(shell.data.items).toBe(items); expect(shell.data.floors).toBe(previousFloors);
  });
  it("retains availability on HTTP failure", async () => {
    await render(); const previous = shell.data.availabilityByItemId;
    custom = url => url.includes("/availability") ? response({}, false) : undefined;
    await act(async () => shell.refreshAvailability()); expect(shell.data.availabilityByItemId).toBe(previous);
  });
  it("polls tables once per cadence across rerenders and skips overlapping calls", async () => {
    await render(); const pending = deferred<Response>(); custom = url => url.includes("/tables?") ? pending.promise : undefined;
    await act(async () => vi.advanceTimersByTimeAsync(5000)); await render(h("div", null, "order"));
    await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(calls("/api/pos/tables")).toHaveLength(2);
    await act(async () => pending.resolve(response({ floors: [{ ...floors[0], name: "Updated" }] })));
    expect(shell.data.floors[0].name).toBe("Updated");
    custom = url => url.includes("/tables?") ? response({}, false) : undefined;
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(shell.data.floors[0].name).toBe("Updated");
  });
  it("notifies READY inside an order route without a false initial notification", async () => {
    await render(h(OrderClient, { tableId: "5" })); expect(beep).not.toHaveBeenCalled();
    custom = url => url.includes("/tables?") ? response({ floors: [{ ...floors[0], tables: [{ ...floors[0].tables[1], readyItems: [{ id: "ready1", name: "Soup" }] }] }] }) : undefined;
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(beep).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Porudžbina je spremna za preuzimanje");
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(beep).toHaveBeenCalledTimes(1);
  });
  it("keeps the sound preference through child changes", async () => {
    await render(); await act(async () => shell.toggleReadySound()); await render(h("div", null, "order"));
    expect(shell.readySoundOn).toBe(false); expect(localStorage.getItem("tablecore.waiterReadySound")).toBe("off");
  });
  it("drops state and intervals on unmount; new mount fetches a fresh employee", async () => {
    await render(); await act(async () => root.unmount()); const count = fetchMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(20000)); expect(fetchMock).toHaveBeenCalledTimes(count);
    root = createRoot(host); custom = url => url === "/api/pos/me" ? response({ restaurantId: "r1", employeeId: "e2", locationIds: ["l1"], roles: ["WAITER"] }) : undefined;
    await render(); expect(shell.data.employeeId).toBe("e2"); expect(calls("/api/pos/menu/snapshot")).toHaveLength(2);
  });
  it("tables → 5 → tables → 12 → tables → 5 reuses all prepared reference data", async () => {
    await render(h(PosClient)); expect(host.textContent).toContain("Main"); expect(host.textContent).toContain("Smena aktivna");
    for (const id of ["5", "12", "5"]) {
      const before = fetchMock.mock.calls.length;
      await render(h(OrderClient, { tableId: id })); expect(host.textContent).toContain(`Table ${id}`); expect(host.textContent).toContain("Drinks");
      expect(fetchMock.mock.calls.slice(before).map(([url]) => url)).toEqual(["/api/pos/orders", `/api/pos/orders/o${id}`]);
      const after = fetchMock.mock.calls.length; await render(h(PosClient)); expect(fetchMock).toHaveBeenCalledTimes(after);
      expect(host.textContent).not.toContain("Pripremamo vašu smenu");
    }
    expect(calls("/api/pos/me")).toHaveLength(1); expect(calls("/api/pos/menu/snapshot")).toHaveLength(1);
    expect(calls("/api/admin/menu/items")).toHaveLength(0); expect(calls("/api/admin/menu/categories")).toHaveLength(0);
  });
  it("shows the prepared menu before the authoritative order resolves, without old table cart", async () => {
    await render(h(OrderClient, { tableId: "5" }));
    const pending = deferred<Response>(); custom = url => url === "/api/pos/orders/o12" ? pending.promise : undefined;
    await render(h(OrderClient, { tableId: "12" }));
    expect(host.textContent).toContain("Table 12"); expect(host.textContent).not.toContain("Table 5");
    expect(host.textContent).toContain("Coffee"); expect(host.textContent).toContain("Otvaramo porudžbinu");
    expect([...host.querySelectorAll("button")].find(b => b.textContent?.includes("Coffee"))?.disabled).toBe(true);
    await act(async () => pending.resolve(response({ order: order("12") })));
  });
  it("Submit flushes quantity immediately and waits for its server response", async () => {
    await render(h(OrderClient, { tableId: "5" })); const pending = deferred<Response>();
    custom = (_url, options) => options?.method === "PATCH" ? pending.promise : undefined;
    await labelClick("Povećaj količinu — Coffee"); await click("Pošalji nove stavke");
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true);
    expect(calls("/api/pos/orders/o5/submit")).toHaveLength(0);
    await act(async () => pending.resolve(response({ ok: true }))); expect(calls("/api/pos/orders/o5/submit")).toHaveLength(1);
  });
  it("Submit waits for pending DELETE and remove remains immediately visible", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: { ...order(), items: [line, { ...line, id: "i2", name: "Tea" }] } }) : undefined;
    await render(h(OrderClient, { tableId: "5" })); const pending = deferred<Response>();
    custom = (_url, options) => options?.method === "DELETE" ? pending.promise : undefined;
    await labelClick("Ukloni — Tea"); expect(host.textContent).not.toContain("Tea"); await click("Pošalji nove stavke");
    expect(calls("/api/pos/orders/o5/submit")).toHaveLength(0);
    await act(async () => pending.resolve(response({ ok: true }))); expect(calls("/api/pos/orders/o5/submit")).toHaveLength(1);
  });
  it("a failed quantity mutation prevents Submit", async () => {
    await render(h(OrderClient, { tableId: "5" })); custom = (_url, options) => options?.method === "PATCH" ? response({ error: "failed" }, false) : undefined;
    await labelClick("Povećaj količinu — Coffee"); await click("Pošalji nove stavke");
    expect(calls("/api/pos/orders/o5/submit")).toHaveLength(0); expect(host.textContent).toContain("Izmena porudžbine nije sačuvana");
  });
  it("poll responses spanning a completed mutation cannot overwrite the cart", async () => {
    await render(h(OrderClient, { tableId: "5" })); const pending = deferred<Response>();
    custom = url => url === "/api/pos/orders/o5" ? pending.promise : undefined;
    await act(async () => vi.advanceTimersByTimeAsync(4000)); await labelClick("Povećaj količinu — Coffee");
    await act(async () => vi.advanceTimersByTimeAsync(350));
    await act(async () => pending.resolve(response({ order: order() })));
    expect(host.textContent).toContain("400.00");
  });
  it("missing overlay is never explicitly available in derived menu", () => {
    expect(mergeWaiterMenu([menuItem], new Map())[0].availability?.isAvailable === true).toBe(false);
    expect(() => readAvailability({ ...overlay, items: [{ ...overlay.items[0], availability: null }] }, "l1", [menuItem])).toThrow();
  });
  it("StrictMode effect replay still prepares and opens an order once", async () => {
    await act(async () => root.render(h(React.StrictMode, null, h(WaiterShellProvider, null, h(OrderClient, { tableId: "5" })))));
    expect(calls("/api/pos/me")).toHaveLength(1); expect(calls("/api/pos/orders")).toHaveLength(1);
  });
  it("a late response for table 5 cannot replace table 12", async () => {
    const pending = deferred<Response>(); custom = url => url === "/api/pos/orders/o5" ? pending.promise : undefined;
    await render(h(OrderClient, { tableId: "5" })); await render(h(OrderClient, { tableId: "12" }));
    await act(async () => pending.resolve(response({ order: order("5") })));
    expect(host.textContent).toContain("Table 12"); expect(host.textContent).not.toContain("Table 5");
  });
  it("preexisting READY items establish a silent baseline", async () => {
    custom = url => url.includes("/tables?") ? response({ floors: [{ ...floors[0], tables: [{ ...floors[0].tables[0], readyItems: [{ id: "already-ready", name: "Soup" }] }] }] }) : undefined;
    await render(); await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(beep).not.toHaveBeenCalled();
  });
  it("the 15 second order refresh fetches only live availability", async () => {
    await render(h(OrderClient, { tableId: "5" })); await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(calls("/api/pos/menu/availability")).toHaveLength(2);
    expect(calls("/api/pos/menu/snapshot")).toHaveLength(1); expect(calls("/api/admin/menu/items")).toHaveLength(0);
  });
  it("rapid quantity changes remain immediate and coalesce to the final PATCH", async () => {
    await render(h(OrderClient, { tableId: "5" }));
    await labelClick("Povećaj količinu — Coffee"); await labelClick("Povećaj količinu — Coffee");
    expect(host.textContent).toContain("600.00"); expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(350));
    const patches = fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH");
    expect(patches).toHaveLength(1); expect(JSON.parse(patches[0][1].body)).toEqual({ quantity: 3 });
  });
  it("remove cancels an unsent quantity update", async () => {
    await render(h(OrderClient, { tableId: "5" }));
    await labelClick("Povećaj količinu — Coffee"); await labelClick("Ukloni — Coffee");
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(1);
  });
  it("Submit waits for a server-backed first add without making it optimistic", async () => {
    const second = { ...menuItem, id: "m2", name: "Tea" };
    custom = url => url.includes("/snapshot") ? response({ ...menu, items: [menuItem, second] }) : url.includes("/availability") ? response({ ...overlay, items: [overlay.items[0], { ...overlay.items[0], menuItemId: "m2" }] }) : undefined;
    await render(h(OrderClient, { tableId: "5" })); const pending = deferred<Response>();
    custom = url => url === "/api/pos/orders/o5/items" ? pending.promise : undefined;
    await click("Tea"); expect(host.querySelector('[aria-label="Ukloni — Tea"]')).toBeNull();
    await click("Pošalji nove stavke"); expect(calls("/api/pos/orders/o5/submit")).toHaveLength(0);
    await act(async () => pending.resolve(response({ item: { ...line, id: "i2", menuItemId: "m2", name: "Tea" } })));
    expect(calls("/api/pos/orders/o5/submit")).toHaveLength(1);
  });
  it("modifier groups and options are rendered from the snapshot", async () => {
    custom = url => url.includes("/snapshot") ? response({ ...menu, items: [{ ...menuItem, modifierGroups: [{ group: { id: "g1", name: "Milk", required: false, minSelect: 0, maxSelect: 1, isActive: true, options: [{ id: "opt1", name: "Oat milk", priceDelta: "30", isActive: true }] } }] }] }) : undefined;
    await render(h(OrderClient, { tableId: "5" })); await click("Coffee");
    expect(host.textContent).toContain("Oat milk"); expect(host.textContent).toContain("Milk");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("modifiers"))).toBe(false);
  });
  it("an old status poll cannot undo a completed Submit with the same order status", async () => {
    await render(h(OrderClient, { tableId: "5" })); const pending = deferred<Response>();
    custom = url => url === "/api/pos/orders/o5" ? pending.promise : url.endsWith("/submit") ? response({ order: { ...order(), items: [{ ...line, status: "SUBMITTED" }] } }) : undefined;
    await act(async () => vi.advanceTimersByTimeAsync(4000)); await click("Pošalji nove stavke");
    await act(async () => pending.resolve(response({ order: order() })));
    expect(host.querySelector('[aria-label="Ukloni — Coffee"]')).toBeNull();
  });
});
