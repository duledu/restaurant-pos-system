// @vitest-environment jsdom
import React, { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WaiterShellProvider, useWaiterShell, type WaiterShellContextValue } from "../../apps/web/lib/waiter-shell";
import { PosClient } from "../../apps/web/app/waiter/tables/pos-client";
import { OrderClient } from "../../apps/web/app/waiter/tables/[tableId]/order-client";
import { readAvailability, mergeWaiterMenu } from "../../apps/web/lib/waiter-menu";

// P0.6 finding #1 — PosClient now also calls router.prefetch() once table
// data is known (see pos-client.tsx); the mock needs that method too or
// every test mounting PosClient throws. Hoisted + shared so a dedicated
// test can assert on it directly (see "P0.6 findings" describe below).
const { routerPush, routerPrefetch } = vi.hoisted(() => ({ routerPush: vi.fn(), routerPrefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush, prefetch: routerPrefetch }) }));
vi.mock("../../apps/web/components/branding/AppLogo", () => ({ AppLogo: () => null }));
vi.mock("../../apps/web/components/ui/QuickLockButton", () => ({ QuickLockButton: () => null }));
vi.mock("../../apps/web/components/ui/LogoutButton", () => ({ LogoutButton: () => null }));

const menuItem = { id: "m1", name: "Coffee", price: "200", categoryId: "c1", preparationStation: "BAR", modifierGroups: [] };
const menu = { restaurantId: "r1", locationId: "l1", menuVersion: 1, categories: [{ id: "c1", name: "Drinks", type: "DRINK" }], items: [menuItem] };
const overlay = { locationId: "l1", items: [{ menuItemId: "m1", stock: null, recipeAvailability: null, availability: { isAvailable: true, reasonCode: null, reasonLabel: null } }] };
const floors = [{ id: "f1", name: "Main", tables: ["5", "12"].map(id => ({ id, label: `Table ${id}`, status: "FREE", capacity: 4, activeOrderOwnerId: "e1", readyItems: [] })) }];
const line = { id: "i1", menuItemId: "m1", name: "Coffee", price: "200", quantity: 1, note: null, status: "DRAFT", modifiers: [] };
function order(id = "5") { return { id: `o${id}`, tableId: id, locationId: "l1", status: "SUBMITTED", table: { label: `Table ${id}` }, items: [{ ...line }] }; }
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
  routerPush.mockClear(); routerPrefetch.mockClear();
  vi.stubGlobal("AudioContext", class {
    currentTime = 0; destination = {};
    resume = async () => {}; close = async () => {};
    createOscillator = () => ({ frequency: { value: 0 }, connect: () => ({ connect: () => {} }), start: beep, stop: () => {} });
    createGain = () => ({ gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} } });
  });
  fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
    const url = String(input); const result = custom(url, options); if (result) return result;
    const path = url.split("?")[0];
    if (url.startsWith("/api/pos/orders?tableId=")) {
      const id = new URL(url, "http://fixture").searchParams.get("tableId")!;
      // Shared order fixture serves both inspection and the existing polling
      // detail endpoint; this is one recorded fetch, never a chained request.
      const detail = await custom(`/api/pos/orders/o${id}`, options);
      if (detail && !detail.ok) return detail;
      return response({ table: { id, locationId: "l1" }, ...(detail ? await detail.json() : { order: order(id) }) });
    }
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
  it("combined Quick Actions (Kitchen + Bar together) add through the same optimistic queue and repeat a mixed round before responses", async () => {
    const food = { ...menuItem, id: 'food', name: 'Omlet', preparationStation: 'KITCHEN' };
    const history = [{ ...line, status: 'SERVED', submittedAt: '2026-09-13T10:00:00Z' }, { ...line, id: 'food-line', menuItemId: 'food', name: 'Omlet', quantity: 2, status: 'SUBMITTED', submittedAt: '2026-09-13T10:00:00Z' }];
    const gate = deferred<void>(); let sequence = 0;
    custom = (url, options) => {
      if (url.includes('/snapshot')) return response({ ...menu, items: [menuItem, food] });
      if (url.includes('/availability')) return response({ ...overlay, items: ['m1', 'food'].map(menuItemId => ({ ...overlay.items[0], menuItemId })) });
      if (url === '/api/pos/orders/o5') return response({ order: { ...order(), items: history } });
      if (url.endsWith('/items') && options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        return gate.promise.then(() => response({ item: { ...line, id: `added-${++sequence}`, menuItemId: body.menuItemId, name: body.menuItemId === 'food' ? 'Omlet' : 'Coffee', quantity: body.quantity } }));
      }
    };
    await render(h(OrderClient, { tableId: '5' }));
    // Quick Actions is one combined smart-action area — a Kitchen item and a
    // Bar item both surface in the SAME group, never split by station.
    const groups = host.querySelectorAll('section[aria-label="Brzo dodaj"] [role="group"]');
    expect(groups).toHaveLength(1);
    expect(groups[0].textContent).toContain('Omlet'); expect(groups[0].textContent).toContain('Coffee');
    await labelClick('Brzo dodaj — Omlet'); await labelClick('Brzo dodaj — Coffee');
    await click('Ponovi poslednju rundu');
    const current = shell.getDraft('5').getSnapshot().order!;
    expect(current.items.filter(i => i.status === 'DRAFT').reduce((n,i) => n+i.quantity, 0)).toBe(5);
    expect(current.items.filter(i => i.status !== 'DRAFT')).toEqual(history);
    expect(shell.getDraft('5').pending).toBe(true);
    await act(async () => { gate.resolve(); await shell.getDraft('5').flush(); });
    expect(shell.getDraft('5').getSnapshot().order!.items.filter(i => i.status === 'DRAFT').reduce((n,i) => n+i.quantity, 0)).toBe(5);
  });
  it("cold hydration failure exposes retry without a partial menu or order creation", async () => {
    custom = url => url.startsWith('/api/pos/orders?') ? response({ error: 'Offline' }, false) : undefined;
    await render(h(OrderClient, { tableId: '5' }));
    expect(host.querySelector('input')).toBeNull(); expect(host.textContent).toContain('Pokušaj ponovo');
    custom = () => undefined; await click('Pokušaj ponovo');
    expect(host.querySelector('.fixed.bottom-0')?.textContent).toContain('Coffee');
    expect(fetchMock.mock.calls.some(([,options]) => options?.method === 'POST')).toBe(false);
  });
  it("cached occupied hydration stays usable during a delayed background read", async () => {
    await render(h(OrderClient, { tableId: '5' })); await render(h(PosClient));
    const pending = deferred<Response>(); custom = url => url.startsWith('/api/pos/orders?') ? pending.promise : undefined;
    await render(h(OrderClient, { tableId: '5' }));
    expect(host.querySelector('.fixed.bottom-0')?.textContent).toContain('Coffee');
    expect(host.textContent).not.toContain('Pripremamo sto i porudžbinu');
    await act(async () => pending.resolve(response({ table: { id: '5', locationId: 'l1' }, order: order() })));
  });
  it("broad search progressively exposes every match and precise queries still search the whole menu", async () => {
    const items = Array.from({ length: 125 }, (_, i) => ({ ...menuItem, id: `m${i}`, name: `Drink ${i}` }));
    custom = url => url.includes('/snapshot') ? response({ ...menu, items })
      : url.includes('/availability') ? response({ ...overlay, items: items.map(i => ({ ...overlay.items[0], menuItemId: i.id })) }) : undefined;
    await render(h(OrderClient, { tableId: '5' }));
    const input = host.querySelector('input')!;
    const search = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const count = () => [...host.querySelectorAll('button')].filter(b => b.className.includes('min-h-[104px]')).length;
    expect(count()).toBe(125); // Categories are not capped.
    await search('Drink'); expect(count()).toBe(60); expect(host.textContent).toContain('60 od 125');
    await click('Prikaži još'); expect(count()).toBe(120);
    await click('Prikaži još'); expect(count()).toBe(125); expect(host.textContent).not.toContain('Prikaži još');
    await search('Drink 124'); expect(count()).toBe(1);
    await search('Drink'); expect(count()).toBe(60);
  });
  it("cold occupied inspection is one GET, with no order creation", async () => {
    await render(h(OrderClient, { tableId: "5" }));
    expect(host.querySelector('.fixed.bottom-0')?.textContent).toContain("Coffee");
    expect(calls("/api/pos/orders")).toHaveLength(1);
    expect(calls("/api/pos/orders")[0][0]).toBe("/api/pos/orders?tableId=5");
    expect(calls("/api/pos/orders")[0][1]?.method).not.toBe("POST");
    expect(calls("/api/pos/orders/o5")).toHaveLength(0);
  });
  it("empty inspection creates nothing; only explicit start opens an order", async () => {
    custom = url => url.startsWith('/api/pos/orders?') ? response({ table: { id: '5', locationId: 'l1' }, order: null }) : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    expect(shell.getDraft("5").getSnapshot().order).toBeNull();
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
    await click("Započni porudžbinu");
    expect(host.querySelector('.fixed.bottom-0')?.textContent).toContain("Coffee");
    expect(fetchMock.mock.calls.filter(([u, o]) => u === '/api/pos/orders' && o?.method === 'POST')).toHaveLength(1);
  });
  it("cached empty inspection is local-first and creation stays queued across navigation", async () => {
    const create = deferred<Response>();
    custom = (url, options) => url.startsWith('/api/pos/orders?') ? response({ table: { id: '5', locationId: 'l1' }, order: null })
      : url === '/api/pos/orders' && options?.method === 'POST' ? create.promise : undefined;
    await render(h(OrderClient, { tableId: '5' })); await render(h(PosClient));
    const read = deferred<Response>();
    custom = (url, options) => url.startsWith('/api/pos/orders?') ? read.promise
      : url === '/api/pos/orders' && options?.method === 'POST' ? create.promise : undefined;
    await render(h(OrderClient, { tableId: '5' }));
    expect(host.textContent).toContain('Započni porudžbinu');
    await click('Započni porudžbinu'); await render(h(PosClient)); await render(h(OrderClient, { tableId: '5' }));
    await click('Započni porudžbinu'); // The table-owned pending queue rejects a second create.
    expect(fetchMock.mock.calls.filter(([u, o]) => u === '/api/pos/orders' && o?.method === 'POST')).toHaveLength(1);
    await act(async () => create.resolve(response({ order: order() })));
    await act(async () => read.resolve(response({ table: { id: '5', locationId: 'l1' }, order: order() })));
    expect(host.querySelector('.fixed.bottom-0')?.textContent).toContain('Coffee');
  });
  it("normal modifier confirmation remains immediate and preserves its selected option", async () => {
    const drink = { ...menuItem, modifierGroups: [{ group: { id: 'g', name: 'Extras', isActive: true, required: false, minSelect: 0, maxSelect: 1, options: [{ id: 'lemon', name: 'Lemon', priceDelta: '20', isActive: true }] } }] };
    const added = deferred<Response>();
    custom = url => url.includes('/snapshot') ? response({ ...menu, items: [drink] }) : url === '/api/pos/orders/o5/items' ? added.promise : undefined;
    await render(h(OrderClient, { tableId: '5' })); await click('Coffee'); await click('Lemon');
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('Dodaj') && b.textContent.includes('RSD'))!.click());
    expect(JSON.parse(calls('/api/pos/orders/o5/items')[0][1].body).modifierOptionIds).toEqual(['lemon']);
    expect(host.querySelector('.fixed.bottom-0')?.textContent).toContain('420.00');
    expect(shell.getDraft('5').getSnapshot().order!.items).toHaveLength(2);
    await act(async () => added.resolve(response({ item: { ...line, id: 'lemon-row', price: '220', modifiers: [{ id: 'opt', modifierOptionId: 'lemon', groupName: 'Extras', optionName: 'Lemon', priceDelta: '20' }] } })));
  });
  it("rejects an order belonging to a different table even on the same location", async () => {
    custom = url => url.startsWith('/api/pos/orders?') ? response({ table: { id: '5', locationId: 'l1' }, order: order('12') }) : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    expect(shell.getDraft("5").getSnapshot().order).toBeNull();
    expect(host.textContent).not.toContain("Započni porudžbinu");
  });
  it("an inspected empty table discovers a remotely opened order through read-only polling", async () => {
    custom = url => url.startsWith('/api/pos/orders?') ? response({ table: { id: '5', locationId: 'l1' }, order: null }) : undefined;
    await render(h(OrderClient, { tableId: '5' }));
    custom = () => undefined;
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(host.querySelector('.fixed.bottom-0')?.textContent).toContain('Coffee');
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
  });
  it("a late empty inspection cannot erase a newer pending add", async () => {
    await render(h(OrderClient, { tableId: "5" })); await render(h(PosClient));
    const read = deferred<Response>();
    custom = url => url.startsWith('/api/pos/orders?') ? read.promise : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    await labelClick("Povećaj količinu — Coffee");
    await act(async () => read.resolve(response({ table: { id: '5', locationId: 'l1' }, order: null })));
    expect(shell.getDraft("5").getSnapshot().order?.items[0].quantity).toBe(2);
  });
  it("category/search state stays coherent through cart updates", async () => {
    const tea = { ...menuItem, id: 'tea', name: 'Tea', categoryId: 'c2' };
    const read = deferred<Response>();
    custom = url => url.includes('/snapshot') ? response({ ...menu, categories: [...menu.categories, { id: 'c2', name: 'Food', type: 'FOOD' }], items: [menuItem, tea] })
      : url.includes('/availability') ? response({ ...overlay, items: [...overlay.items, { ...overlay.items[0], menuItemId: 'tea' }] })
      : url.startsWith('/api/pos/orders?') ? read.promise : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    await act(async () => read.resolve(response({ table: { id: '5', locationId: 'l1' }, order: order() })));
    await click('Food');
    const menuButtons = () => [...host.querySelectorAll('button')].filter(b => b.className.includes('min-h-[104px]')).map(b => b.textContent);
    expect(menuButtons().join()).toContain('Tea'); expect(menuButtons().join()).not.toContain('Coffee');
    await labelClick("Povećaj količinu — Coffee"); expect(menuButtons().join()).toContain('Tea');
    const input = host.querySelector('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Coffee'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(menuButtons().join()).toContain('Coffee'); expect(menuButtons().join()).not.toContain('Tea');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(menuButtons().join()).toContain('Tea');
  });
  it("unchanged order, table and availability polls preserve accepted references", async () => {
    await render(h(OrderClient, { tableId: "5" }));
    const data = shell.data;
    const snapshot = shell.getDraft("5").getSnapshot();
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(shell.data).toBe(data);
    expect(shell.getDraft("5").getSnapshot()).toBe(snapshot);
  });
  describe("complete active order restore", () => {
    it("a late READY poll cannot undo pickup confirmation", async () => {
      const ready = { ...order(), items: [{ ...line, status: "READY" }] };
      custom = url => url === "/api/pos/orders/o5" ? response({ order: ready }) : undefined;
      await render(h(OrderClient, { tableId: "5" }));
      const poll = deferred<Response>();
      custom = url => url === "/api/pos/orders/o5" ? poll.promise : url.endsWith("/pickup") ? response({ ok: true }) : undefined;
      await act(async () => vi.advanceTimersByTimeAsync(4000));
      await click("Preuzeto");
      await act(async () => poll.resolve(response({ order: ready })));
      expect(shell.getDraft("5").getSnapshot().order!.items[0].status).toBe("SERVED");
    });
    it("revalidates a cached DRAFT after a racing local add discards the reopen response", async () => {
      await render(h(OrderClient, { tableId: "5" }));
      await act(async () => shell.getDraft("5").setOrder(previous => ({ ...previous!, status: "DRAFT" })));
      await render(h(PosClient));
      const reopen = deferred<Response>(); let reads = 0;
      const updated = { ...order(), items: [{ ...line }, { ...line, id: "remote", name: "Other waiter round", status: "SUBMITTED" }] };
      custom = url => url === "/api/pos/orders/o5" ? (++reads === 1 ? reopen.promise : response({ order: updated })) : undefined;
      await render(h(OrderClient, { tableId: "5" }));
      await labelClick("Povećaj količinu — Coffee");
      await act(async () => reopen.resolve(response({ order: updated })));
      await act(async () => vi.advanceTimersByTimeAsync(8000));
      expect(host.textContent).toContain("Other waiter round");
    });
    it("an older reopen response cannot replace a newer polling snapshot", async () => {
      await render(h(OrderClient, { tableId: "5" })); await render(h(PosClient));
      const reopen = deferred<Response>(); let reads = 0;
      const updated = { ...order(), items: [{ ...line }, { ...line, id: "remote", name: "Other waiter round", status: "READY" }] };
      custom = url => url === "/api/pos/orders/o5" ? (++reads === 1 ? reopen.promise : response({ order: updated })) : undefined;
      await render(h(OrderClient, { tableId: "5" }));
      await act(async () => vi.advanceTimersByTimeAsync(4000));
      expect(host.textContent).toContain("Other waiter round");
      await act(async () => reopen.resolve(response({ order: order() })));
      expect(host.textContent).toContain("Other waiter round");
    });
    const panel = () => host.querySelector<HTMLElement>(".fixed.bottom-0")!;
    const submittedBox = () => host.querySelector<HTMLElement>('div[class*="24dvh"]');
    // Physical-device regression fix: the editable panel ("Tekuća porudžbina")
    // must show ONLY draft rows — submitted/served rows live exclusively in
    // "Poslato / U pripremi" and must never repeat inside the panel below it.
    function expectSubmittedIntact() {
      expect(submittedBox()?.textContent).toContain("Coffee");
      expect(submittedBox()?.textContent).toContain("Omlet");
      expect(panel().textContent).not.toContain("Omlet");
    }
    function expectDraft(quantity: number, total: string) {
      if (quantity === 0) {
        expect(panel().textContent).toContain("0 stavki");
        expect(panel().textContent).toContain("Nema novih stavki.");
        return;
      }
      expect(panel().textContent).toContain(`${quantity} stavki`);
      expect(panel().textContent).toContain(total);
      expect(panel().textContent).not.toContain("Nema novih stavki.");
    }
    function fixture() {
      const drinks = [menuItem, { ...menuItem, id: "m2", name: "Omlet", price: "300" }, { ...menuItem, id: "m3", name: "Cedevita", price: "150" }];
      const sent = [{ ...line, id: "sent1", quantity: 2, status: "SUBMITTED", submittedAt: "2026-09-13T10:00:00Z" }, { ...line, id: "sent2", menuItemId: "m2", name: "Omlet", price: "300", status: "SERVED", submittedAt: "2026-09-13T10:00:00Z" }];
      let serverItems = [...sent]; let sequence = 0;
      let held: ReturnType<typeof deferred<Response>> | null = null;
      custom = (url, options) => {
        if (url.includes("/snapshot")) return response({ ...menu, items: drinks });
        if (url.includes("/availability")) return response({ ...overlay, items: drinks.map(item => ({ ...overlay.items[0], menuItemId: item.id })) });
        if (url === "/api/pos/orders/o5") return response({ order: { ...order(), items: serverItems } });
        if (url === "/api/pos/orders/o12") return response({ order: { ...order("12"), items: [{ ...line, id: "other", name: "Other table", status: "SUBMITTED" }] } });
        if (url === "/api/pos/orders/o5/items") {
          const input = JSON.parse(String(options?.body)); const menu = drinks.find(item => item.id === input.menuItemId)!;
          const created = { ...line, id: `added${++sequence}`, name: menu.name, menuItemId: menu.id, price: menu.price };
          serverItems = [...serverItems, created];
          return held ? held.promise : response({ item: created });
        }
        if (options?.method === "PATCH") { const input = JSON.parse(String(options.body)); serverItems = serverItems.map(item => url.endsWith(`/${item.id}`) ? { ...item, quantity: input.quantity } : item); return response({ ok: true }); }
        if (url.endsWith("/submit")) { serverItems = serverItems.map(item => item.status === "DRAFT" ? { ...item, status: "SUBMITTED", submittedAt: "2026-09-13T11:00:00Z" } : item); return response({ order: { ...order(), items: serverItems } }); }
        return undefined;
      };
      return { sent, hold: () => held = deferred<Response>(), created: () => serverItems.at(-1)! };
    }
    it("reopens submitted server items into the read-only submitted section, with an empty editable draft panel", async () => {
      const f = fixture(); await render(h(OrderClient, { tableId: "5" }));
      expect(shell.getDraft("5").getSnapshot().order!.items).toEqual(f.sent);
      expectSubmittedIntact(); expectDraft(0, "0.00");
    });
    it("preserves submitted rows through leaving and returning, still with an empty draft panel", async () => {
      fixture(); await render(h(OrderClient, { tableId: "5" })); await render(h(PosClient)); await render(h(OrderClient, { tableId: "5" }));
      expectSubmittedIntact(); expectDraft(0, "0.00");
    });
    it("renders the new item ALONE in the draft panel before server confirmation, submitted rows untouched", async () => {
      const f = fixture(); await render(h(OrderClient, { tableId: "5" })); const pending = f.hold();
      await click("Cedevita"); expectDraft(1, "150.00"); expect(panel().textContent).toContain("Cedevita");
      expectSubmittedIntact();
      expect(shell.getDraft("5").getSnapshot().order!.items.filter(i => i.status !== "DRAFT")).toEqual(f.sent);
      await act(async () => pending.resolve(response({ item: f.created() })));
    });
    it("instant quantity +1 stays inside the draft panel and does not touch submitted rows", async () => {
      const f = fixture(); await render(h(OrderClient, { tableId: "5" })); const pending = f.hold();
      await click("Cedevita"); await labelClick("Povećaj količinu — Cedevita"); expectDraft(2, "300.00"); expectSubmittedIntact();
      await act(async () => pending.resolve(response({ item: f.created() })));
    });
    it("P0.5 chip creates a separate draft row without changing the already-submitted Coffee round", async () => {
      fixture(); await render(h(OrderClient, { tableId: "5" })); await labelClick("Brzo dodaj — Coffee"); expectDraft(1, "200.00");
      expect(shell.getDraft("5").getSnapshot().order!.items.find(i => i.id === "sent1")?.quantity).toBe(2);
      expectSubmittedIntact();
    });
    it("polling and availability refresh preserve the pending draft item and leave submitted rows alone", async () => {
      const f = fixture(); await render(h(OrderClient, { tableId: "5" })); const pending = f.hold();
      await click("Cedevita"); await act(async () => vi.advanceTimersByTimeAsync(15000)); expectDraft(1, "150.00");
      await act(async () => pending.resolve(response({ item: f.created() }))); await act(async () => vi.advanceTimersByTimeAsync(4000)); expectDraft(1, "150.00");
      expectSubmittedIntact();
    });
    it("Submit waits for pending work, then reconciles the new item into submitted status with an empty draft panel", async () => {
      const f = fixture(); await render(h(OrderClient, { tableId: "5" })); const pending = f.hold();
      await click("Cedevita"); await click("Pošalji nove stavke"); expect(calls("/api/pos/orders/o5/submit")).toHaveLength(0);
      await act(async () => pending.resolve(response({ item: f.created() })));
      expectDraft(0, "0.00");
      expect(shell.getDraft("5").getSnapshot().order!.items).toHaveLength(3);
      expect(shell.getDraft("5").getSnapshot().order!.items.every(i => i.status !== "DRAFT")).toBe(true);
      expect(submittedBox()?.textContent).toContain("Cedevita");
      expect(calls("/api/pos/orders/o5/submit")).toHaveLength(1);
      expect(JSON.parse(calls("/api/pos/orders/o5/submit")[0][1].body)).toEqual({ idempotencyKey: expect.any(String) });
    });
    it("reopens with the newly-submitted item in the submitted section, draft panel empty again", async () => {
      fixture(); await render(h(OrderClient, { tableId: "5" })); await click("Cedevita"); await click("Pošalji nove stavke");
      await render(h(PosClient)); await render(h(OrderClient, { tableId: "5" }));
      expectDraft(0, "0.00"); expect(submittedBox()?.textContent).toContain("Cedevita");
    });
    it("isolates active table orders — table 12's submitted row never leaks into table 5's view or vice versa", async () => {
      fixture(); await render(h(OrderClient, { tableId: "5" })); await render(h(OrderClient, { tableId: "12" }));
      // "Omlet" is also a real catalog item, so it always appears in the shared
      // menu grid — the isolation check must be scoped to the submitted section.
      expect(submittedBox()?.textContent).toContain("Other table");
      expect(submittedBox()?.textContent).not.toContain("Omlet");
      await render(h(OrderClient, { tableId: "5" }));
      expectSubmittedIntact(); expect(submittedBox()?.textContent).not.toContain("Other table");
    });
    it("a locally-added CANCELLED line never appears as a draft row nor inflates the editable panel", async () => {
      fixture(); await render(h(OrderClient, { tableId: "5" }));
      await act(async () => shell.getDraft("5").setOrder(previous => ({ ...previous!, items: [...previous!.items, { ...line, id: "voided", status: "CANCELLED", quantity: 10 }] })));
      expectDraft(0, "0.00"); expectSubmittedIntact();
    });
    it("uses item history even when aggregate order status is DRAFT — nothing shown as an editable draft row", async () => {
      fixture(); await render(h(OrderClient, { tableId: "5" }));
      await act(async () => shell.getDraft("5").setOrder(previous => ({ ...previous!, status: "DRAFT" })));
      expectDraft(0, "0.00"); expect(host.textContent).toContain("Poslato / U pripremi");
      expect(panel().querySelectorAll('button[aria-label^="Ukloni"]')).toHaveLength(0);
      const submit = [...panel().querySelectorAll("button")].find(b => b.textContent === "Pošalji nove stavke");
      expect(submit?.disabled).toBe(true);
    });
    it("late polling response cannot erase the submitted section or the newer optimistic draft row", async () => {
      const f = fixture(); await render(h(OrderClient, { tableId: "5" }));
      const route = custom; const poll = deferred<Response>();
      custom = (url, options) => url === "/api/pos/orders/o5" ? poll.promise : route(url, options);
      await act(async () => vi.advanceTimersByTimeAsync(4000));
      const pending = f.hold(); await click("Cedevita");
      await act(async () => poll.resolve(response({ order: { ...order(), items: f.sent } })));
      expectDraft(1, "150.00"); expectSubmittedIntact();
      await act(async () => pending.resolve(response({ item: f.created() })));
    });
    it("failed optimistic add and retry keep the draft row isolated from the submitted section", async () => {
      const f = fixture(); await render(h(OrderClient, { tableId: "5" }));
      const route = custom;
      custom = (url, options) => url === "/api/pos/orders/o5/items" ? Promise.reject(new TypeError("offline")) : route(url, options);
      await click("Cedevita"); expectDraft(1, "150.00"); expect(host.textContent).toContain("Pokušaj ponovo");
      custom = route; await click("Pokušaj ponovo"); expectDraft(1, "150.00");
      expectSubmittedIntact();
      expect(shell.getDraft("5").getSnapshot().order!.items.filter(i => i.status !== "DRAFT")).toEqual(f.sent);
      const requests = calls("/api/pos/orders/o5/items").map(([, options]) => JSON.parse(options.body).clientMutationId);
      expect(new Set(requests).size).toBe(1);
    });
    it("READY update keeps the submitted section correct while a new draft item is pending, never duplicated", async () => {
      const f = fixture(); await render(h(OrderClient, { tableId: "5" }));
      await act(async () => shell.getDraft("5").setOrder(previous => ({ ...previous!, items: previous!.items.map(i => i.id === "sent1" ? { ...i, status: "READY" } : i) })));
      const pending = f.hold(); await click("Cedevita"); expectDraft(1, "150.00");
      expect(host.textContent).toContain("Preuzeto");
      await act(async () => pending.resolve(response({ item: f.created() })));
      expectDraft(1, "150.00");
    });
  });
  it("P0.5 modifier quick chip enters the P0.4 draft before confirmation with current price", async () => {
    const drink = { ...menuItem, modifierGroups: [{ group: { id: "g", name: "Dodaci", required: false, minSelect: 0, maxSelect: 1, isActive: true, options: [{ id: "lemon", name: "Limun", priceDelta: "25", isActive: true }] } }] };
    const previous = { ...line, status: "SERVED", submittedAt: "2026-09-13T10:00:00Z", modifiers: [{ id: "mod", modifierOptionId: "lemon", groupName: "Dodaci", optionName: "Limun", priceDelta: "10" }] };
    const pending = deferred<Response>();
    custom = url => url.includes("/snapshot") ? response({ ...menu, items: [drink] }) : url === "/api/pos/orders/o5" ? response({ order: { ...order(), items: [previous] } }) : url === "/api/pos/orders/o5/items" ? pending.promise : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    await labelClick("Brzo dodaj — Coffee · Limun");
    expect(shell.getDraft("5").getSnapshot().order!.items.filter(i => i.status === "DRAFT")).toMatchObject([{ quantity: 1, price: "225.00", modifiers: [{ modifierOptionId: "lemon" }] }]);
    await click("Ponovi poslednju rundu"); await click("Ponovi poslednju rundu");
    expect(shell.getDraft("5").getSnapshot().order!.items.find(i => i.status === "DRAFT")?.quantity).toBe(3);
    await act(async () => pending.resolve(response({ item: { ...previous, id: "confirmed", status: "DRAFT", price: "225" } })));
    const posts = calls("/api/pos/orders/o5/items"); expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body).modifierOptionIds).toEqual(["lemon"]);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH").map(([, options]) => JSON.parse(options.body))).toContainEqual({ quantity: 3 });
  });
  it("P0.5 Table 5 round repeats instantly, sequences rapid +1, waits on Submit and skips unavailable Pivo", async () => {
    const drinks = ["Rakija", "Pivo", "Kisela"].map((name, i) => ({ ...menuItem, id: `m${i + 1}`, name }));
    const history = drinks.map((drink, i) => ({ ...line, id: `submitted${i}`, menuItemId: drink.id, name: drink.name, quantity: i === 2 ? 1 : 2, status: "SERVED", submittedAt: "2026-09-13T10:00:00Z" }));
    const pending = deferred<Response>();
    let blocked = false, delay = false, creates = 0, submitted = false;
    custom = (url, options) => {
      if (url.includes("/snapshot")) return response({ ...menu, items: drinks });
      if (url.includes("/availability")) return response({ ...overlay, items: drinks.map(drink => ({ ...overlay.items[0], menuItemId: drink.id, availability: { ...overlay.items[0].availability, isAvailable: !(blocked && drink.name === "Pivo") } })) });
      if (url === "/api/pos/orders/o5") return response({ order: { ...order(), items: submitted ? history : [] } });
      if (url === "/api/pos/orders/o12") return response({ order: { ...order("12"), items: [] } });
      if (url === "/api/pos/orders/o5/items") {
        const body = JSON.parse(String(options?.body)); const drink = drinks.find(d => d.id === body.menuItemId)!;
        creates++;
        if (delay && creates === 1) return pending.promise;
        return response({ item: { ...line, id: `new${creates}`, menuItemId: drink.id, name: drink.name } });
      }
      if (url.endsWith("/submit")) { submitted = true; return response({ order: { ...order(), items: history } }); }
      return undefined;
    };
    await render(h(OrderClient, { tableId: "5" }));
    for (const name of ["Rakija", "Rakija", "Pivo", "Pivo", "Kisela"]) await click(name);
    expect(shell.getDraft("5").getSnapshot().order!.items.map(i => i.quantity)).toEqual([2, 2, 1]);
    await click("Pošalji nove stavke");
    await render(h(PosClient)); await render(h(OrderClient, { tableId: "5" }));
    creates = 0; delay = true;
    for (const drink of drinks) expect(host.querySelector(`[aria-label="Brzo dodaj — ${drink.name}"]`)).not.toBeNull();
    const start = performance.now(); await click("Ponovi poslednju rundu");
    for (const drink of drinks) expect(host.querySelector(`[aria-label="Ukloni — ${drink.name}"]`)).not.toBeNull();
    expect(shell.getDraft("5").getSnapshot().order!.items.filter(i => i.status === "DRAFT").map(i => i.quantity)).toEqual([2, 2, 1]);
    console.info(`P0.5 repeat to committed DOM: ${(performance.now() - start).toFixed(2)} ms; server unresolved`);
    const chipStart = performance.now(); await labelClick("Brzo dodaj — Pivo");
    console.info(`P0.5 quick +1 to committed DOM: ${(performance.now() - chipStart).toFixed(2)} ms; server unresolved`);
    expect(shell.getDraft("5").getSnapshot().order!.items.find(i => i.status === "DRAFT" && i.name === "Pivo")?.quantity).toBe(3);
    await click("Pošalji nove stavke"); expect(calls("/api/pos/orders/o5/submit")).toHaveLength(1);
    await act(async () => pending.resolve(response({ item: { ...line, id: "new1", name: "Rakija" } })));
    expect(calls("/api/pos/orders/o5/submit")).toHaveLength(2);
    blocked = true; delay = false;
    await act(async () => shell.refreshAvailability());
    expect(host.querySelector('[aria-label="Brzo dodaj — Pivo"]')).toBeNull();
    await render(h(PosClient)); await render(h(OrderClient, { tableId: "5" }));
    await click("Ponovi poslednju rundu");
    expect(host.textContent).toContain("Nije moguće ponoviti: Pivo");
    expect(shell.getDraft("5").getSnapshot().order!.items.filter(i => i.status === "DRAFT").map(i => i.name)).toEqual(["Rakija", "Kisela"]);
    await render(h(OrderClient, { tableId: "12" }));
    expect(host.textContent).not.toContain("Ponovi poslednju rundu");
    expect(host.querySelector('[aria-label="Brzo dodaj"]')?.textContent).toContain("★");
    expect(calls("/api/pos/menu/snapshot")).toHaveLength(1);
  });
  it("P0.5 favorites clear on shell unmount and another waiter starts empty", async () => {
    await render(h(OrderClient, { tableId: "5" })); await click("Coffee");
    const previous = shell.favorites; expect(previous.get()[0].quantity).toBe(1);
    await act(async () => root.render(null)); expect(previous.get()).toEqual([]);
    custom = url => url === "/api/pos/me" ? response({ restaurantId: "r1", employeeId: "e2", roles: ["WAITER"], locationIds: ["l1"] }) : undefined;
    await render(); expect(shell.data.employeeId).toBe("e2"); expect(shell.favorites.get()).toEqual([]);
  });
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
      expect(fetchMock.mock.calls.slice(before).map(([url]) => url)).toEqual([`/api/pos/orders?tableId=${id}`]);
      const after = fetchMock.mock.calls.length; await render(h(PosClient)); expect(fetchMock).toHaveBeenCalledTimes(after);
      expect(host.textContent).not.toContain("Pripremamo vašu smenu");
    }
    expect(calls("/api/pos/me")).toHaveLength(1); expect(calls("/api/pos/menu/snapshot")).toHaveLength(1);
    expect(calls("/api/admin/menu/items")).toHaveLength(0); expect(calls("/api/admin/menu/categories")).toHaveLength(0);
  });
  it("shows intentional cold hydration without partial menu or old table cart, then reveals immediately", async () => {
    await render(h(OrderClient, { tableId: "5" }));
    const pending = deferred<Response>(); custom = url => url === "/api/pos/orders/o12" ? pending.promise : undefined;
    await render(h(OrderClient, { tableId: "12" }));
    expect(host.textContent).toContain("Table 12"); expect(host.textContent).not.toContain("Table 5");
    expect(host.textContent).not.toContain("Coffee"); expect(host.textContent).toContain("Pripremamo sto i porudžbinu");
    expect(host.querySelector('input')).toBeNull(); expect(host.querySelector('.fixed.bottom-0')).toBeNull();
    await act(async () => pending.resolve(response({ order: order("12") })));
    expect(host.querySelector('input')).not.toBeNull(); expect(host.querySelector('.fixed.bottom-0')).not.toBeNull();
    expect(host.textContent).not.toContain("Pripremamo sto i porudžbinu");
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
  // Physical PREPROD waiter crash fix — reproduces the exact real-world race:
  // a waiter adds a new item, then taps +1 on it again before its create
  // request confirms. sendCreation then fires a confirming PATCH; the old
  // server response for that endpoint omitted `modifiers` entirely, and the
  // old client code adopted it verbatim, writing `modifiers: undefined` into
  // the rendered order — crashing the page ("Cannot read properties of
  // undefined (reading 'length')") the next time DraftRow/HistoryRow read
  // item.modifiers.length. This proves the full render path survives even
  // if a PATCH response is still malformed somewhere else in the future.
  it("regression: a quantity bump racing a still-confirming new item never crashes, even if the PATCH response omits modifiers", async () => {
    const second = { ...menuItem, id: "m2", name: "Tea" };
    const pending = deferred<Response>();
    custom = (url, options) => {
      if (url.includes("/snapshot")) return response({ ...menu, items: [menuItem, second] });
      if (url.includes("/availability")) return response({ ...overlay, items: [overlay.items[0], { ...overlay.items[0], menuItemId: "m2" }] });
      if (url === "/api/pos/orders/o5/items" && options?.method === "POST") return pending.promise;
      if (url === "/api/pos/orders/o5/items/tea1" && options?.method === "PATCH") {
        // Simulates the old server bug: `modifiers` relation not included.
        return response({ item: { id: "tea1", menuItemId: "m2", name: "Tea", price: "200.00", quantity: JSON.parse(options.body).quantity, note: null, status: "DRAFT" } });
      }
      return undefined;
    };
    await render(h(OrderClient, { tableId: "5" }));
    await click("Tea"); // starts the create; POST is still pending
    await labelClick("Povećaj količinu — Tea"); // desired quantity becomes 2 while the create is in flight
    await act(async () => {
      pending.resolve(response({ item: { id: "tea1", menuItemId: "m2", name: "Tea", price: "200.00", quantity: 1, note: null, status: "DRAFT",
        modifiers: [{ id: "mod1", modifierOptionId: "opt1", groupName: "Dodaci", optionName: "Limun", priceDelta: "0" }] } }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(host.textContent).toContain("Tea");
    expect(host.querySelector('[aria-label="Povećaj količinu — Tea"]')).not.toBeNull();
  });

  it("remove cancels an unsent quantity update", async () => {
    await render(h(OrderClient, { tableId: "5" }));
    await labelClick("Povećaj količinu — Coffee"); await labelClick("Ukloni — Coffee");
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(1);
  });
  it("Submit waits for the optimistic first add to be confirmed", async () => {
    const second = { ...menuItem, id: "m2", name: "Tea" };
    custom = url => url.includes("/snapshot") ? response({ ...menu, items: [menuItem, second] }) : url.includes("/availability") ? response({ ...overlay, items: [overlay.items[0], { ...overlay.items[0], menuItemId: "m2" }] }) : undefined;
    await render(h(OrderClient, { tableId: "5" })); const pending = deferred<Response>();
    custom = url => url === "/api/pos/orders/o5/items" ? pending.promise : undefined;
    await click("Tea"); expect(host.querySelector('[aria-label="Ukloni — Tea"]')).not.toBeNull();
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
  it("first add paints before delayed POST, and + before confirmation stays visible", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: { ...order(), items: [] } }) : undefined;
    await render(h(OrderClient, { tableId: "5" })); const pending = deferred<Response>();
    custom = url => url === "/api/pos/orders/o5/items" ? pending.promise : undefined;
    const start = performance.now(); await click("Coffee");
    expect(host.querySelector('[aria-label="Ukloni — Coffee"]')).not.toBeNull();
    const firstAddMs = performance.now() - start;
    await labelClick("Povećaj količinu — Coffee"); expect(host.textContent).toContain("400.00");
    await act(async () => pending.resolve(response({ item: { ...line, id: "server-new", price: "210" } })));
    expect(host.textContent).toContain("420.00");
    const patches = fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH");
    expect(patches[0][0]).toBe("/api/pos/orders/o5/items/server-new"); expect(JSON.parse(patches[0][1].body).quantity).toBe(2);
    console.info(`P0.4 mocked-DOM first tap to committed cart: ${firstAddMs.toFixed(2)} ms (server response unresolved)`);
  });
  it("navigation retains pending create and remove completes against its eventual server ID", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: { ...order(), items: [] } }) : undefined;
    await render(h(OrderClient, { tableId: "5" })); const pending = deferred<Response>();
    custom = url => url === "/api/pos/orders/o5/items" ? pending.promise : undefined;
    await click("Coffee"); await render(h(PosClient)); await render(h(OrderClient, { tableId: "5" }));
    expect(host.querySelector('[aria-label="Ukloni — Coffee"]')).not.toBeNull();
    await labelClick("Ukloni — Coffee"); expect(host.querySelector('[aria-label="Ukloni — Coffee"]')).toBeNull();
    await act(async () => pending.resolve(response({ item: { ...line, id: "server-new" } })));
    expect(fetchMock.mock.calls.some(([url, options]) => url === "/api/pos/orders/o5/items/server-new" && options.method === "DELETE")).toBe(true);
  });
  it("status polling cannot overwrite a newly optimistic row", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: { ...order(), items: [] } }) : undefined;
    await render(h(OrderClient, { tableId: "5" })); const poll = deferred<Response>(); const create = deferred<Response>();
    custom = url => url === "/api/pos/orders/o5" ? poll.promise : url === "/api/pos/orders/o5/items" ? create.promise : undefined;
    await act(async () => vi.advanceTimersByTimeAsync(4000)); await click("Coffee");
    await act(async () => poll.resolve(response({ order: { ...order(), items: [] } })));
    expect(host.querySelector('[aria-label="Ukloni — Coffee"]')).not.toBeNull();
    await act(async () => create.resolve(response({ item: { ...line, id: "server-new" } })));
  });
  it("rejected optimistic add rolls back without reloading reference data", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: { ...order(), items: [] } }) : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    // A 400 is a definite business rejection; 500 remains retryable.
    custom = url => url === "/api/pos/orders/o5/items" ? { ok: false, status: 400, json: async () => ({ error: "unavailable" }) } as Response : undefined;
    await click("Coffee"); expect(host.querySelector('[aria-label="Ukloni — Coffee"]')).toBeNull();
    expect(host.textContent).toContain("Nije moguće dodati artikal"); expect(calls("/api/pos/menu/snapshot")).toHaveLength(1);
  });
  it("Submit guard survives navigating away and reopening the same table", async () => {
    await render(h(OrderClient, { tableId: "5" })); const pending = deferred<Response>();
    custom = url => url.endsWith("/submit") ? pending.promise : undefined;
    await click("Pošalji nove stavke"); await render(h(PosClient)); await render(h(OrderClient, { tableId: "5" }));
    const button = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Slanje"));
    expect(button?.disabled).toBe(true); expect(calls("/api/pos/orders/o5/submit")).toHaveLength(1);
    await act(async () => pending.resolve(response({ order: { ...order(), items: [{ ...line, status: "SUBMITTED" }] } })));
    expect(host.querySelector('[aria-label="Ukloni — Coffee"]')).toBeNull();
  });
  it("does not render the menu grid while opening a confirmed-empty table's first order", async () => {
    custom = url => url.startsWith("/api/pos/orders?tableId=") ? response({ table: { id: "5", locationId: "l1" }, order: null }) : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    expect(host.textContent).toContain("Sto je slobodno");
    expect(host.querySelector("input")).not.toBeNull(); // confirmed-empty: menu visible immediately, no fetch pending
    const opening = deferred<Response>();
    custom = (url, options) => url === "/api/pos/orders" && options?.method === "POST" ? opening.promise : undefined;
    await click("Započni porudžbinu");
    expect(host.textContent).toContain("Otvaramo porudžbinu");
    expect(host.querySelector("input")).toBeNull(); // opening: menu grid hidden, not half-initialized underneath
    await act(async () => opening.resolve(response({ order: order("5") })));
    expect(host.querySelector("input")).not.toBeNull();
  });
});

describe("KUHINJA/ŠANK main-menu section switch", () => {
  const pizza = { ...menuItem, id: "pizza", name: "Pizza", categoryId: "c2", preparationStation: "KITCHEN" };
  const combo = { ...menuItem, id: "combo", name: "Kombo", categoryId: "c2", preparationStation: "KITCHEN_AND_BAR" };
  const cola = { ...menuItem, id: "m1", name: "Cola", categoryId: "c1", preparationStation: "BAR" };
  const sectionsMenu = { ...menu, categories: [{ id: "c1", name: "Pića", type: "DRINK" }, { id: "c2", name: "Hrana", type: "FOOD" }], items: [cola, pizza, combo] };
  const sectionsOverlay = { ...overlay, items: ["m1", "pizza", "combo"].map(menuItemId => ({ ...overlay.items[0], menuItemId })) };

  it("switches KUHINJA<->ŠANK locally (no fetch), scopes categories/items to the section, and shows a dual-route item in both", async () => {
    custom = url => url.includes("/snapshot") ? response(sectionsMenu) : url.includes("/availability") ? response(sectionsOverlay) : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    const before = fetchMock.mock.calls.length;

    // Default section is KUHINJA (the menu has kitchen items). Pića has no
    // kitchen-visible item at all, so its chip is not shown yet.
    expect(host.textContent).toContain("Hrana"); expect(host.textContent).not.toContain("Pića");
    expect(host.textContent).toContain("Pizza"); expect(host.textContent).toContain("Kombo"); expect(host.textContent).not.toContain("Cola");

    await click("ŠANK");
    // Pića now appears as a chip (Cola). Hrana ALSO appears — it legitimately
    // belongs to both sections because it holds Kombo (KITCHEN_AND_BAR) — and
    // since Hrana is still valid under ŠANK, the active category is left
    // exactly where it was (no jarring reset): the grid still shows Kombo,
    // not yet Cola, until Pića itself is tapped.
    expect(host.textContent).toContain("Pića"); expect(host.textContent).toContain("Hrana");
    expect(host.textContent).toContain("Kombo"); expect(host.textContent).not.toContain("Pizza"); expect(host.textContent).not.toContain("Cola");
    expect(fetchMock.mock.calls.length).toBe(before);

    await click("Pića");
    expect(host.textContent).toContain("Cola"); expect(host.textContent).not.toContain("Pizza"); expect(host.textContent).not.toContain("Kombo");
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("scopes search to the selected section", async () => {
    custom = url => url.includes("/snapshot") ? response(sectionsMenu) : url.includes("/availability") ? response(sectionsOverlay) : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    const input = host.querySelector("input")!;
    const type = (text: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });

    // KUHINJA is selected — Cola (Bar-only) is not found by name.
    await type("Cola");
    expect(host.textContent).toContain("Nema artikala.");
    expect(host.textContent).not.toContain("Cola");

    await type("");
    await click("ŠANK");
    await type("Cola");
    expect(host.textContent).toContain("Cola");
  });
});

describe("Oslobodi sto", () => {
  function draftOrder() { return { ...order(), status: "DRAFT", items: [{ ...line }] }; } // never submitted

  it("is hidden once anything has ever been submitted", async () => {
    await render(h(OrderClient, { tableId: "5" })); // fixture order.status is SUBMITTED
    expect(host.textContent).not.toContain("Oslobodi sto");
  });
  it("is visible while the order is still DRAFT (nothing ever sent to Kitchen/Bar)", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: draftOrder() }) : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    expect(host.textContent).toContain("Oslobodi sto");
  });
  it("does nothing when the confirmation is declined", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: draftOrder() }) : undefined;
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await render(h(OrderClient, { tableId: "5" }));
    const before = fetchMock.mock.calls.length;
    await click("Oslobodi sto");
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(shell.getDraft("5").getSnapshot().order).not.toBeNull();
  });
  it("releases the table on confirmation, clearing the local draft without resurrecting the order", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: draftOrder() }) : url.endsWith("/release") ? response({ orderId: "o5", status: "CANCELLED" }) : undefined;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render(h(OrderClient, { tableId: "5" }));
    await click("Oslobodi sto");
    expect(calls("/api/pos/orders/o5/release")).toHaveLength(1);
    const snapshot = shell.getDraft("5").getSnapshot();
    expect(snapshot.order).toBeNull();
    expect(snapshot.inspected).toBe(true); // confirmed-empty, not cold — reopening will not flash "Pripremamo sto..."
  });
  it("surfaces a server rejection without clearing the order", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: draftOrder() }) : url.endsWith("/release") ? response({ error: "Porudžbina je u međuvremenu poslata" }, false) : undefined;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await render(h(OrderClient, { tableId: "5" }));
    await click("Oslobodi sto");
    expect(host.textContent).toContain("Porudžbina je u međuvremenu poslata");
    expect(shell.getDraft("5").getSnapshot().order).not.toBeNull();
  });
});

describe("Tekuća porudžbina does not duplicate submitted rows (physical-device regression)", () => {
  function servedItems() {
    return ["Item0", "Item1", "Item2", "Item3"].map((name, i) => ({ ...line, id: `s${i}`, menuItemId: null, name, status: "SERVED", submittedAt: "2026-09-13T10:00:00Z" }));
  }
  function servedOrder() { return { ...order(), items: servedItems() }; }

  it("4 submitted/SERVED items render exactly once each, and zero times in the editable draft panel", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: servedOrder() }) : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    for (const name of ["Item0", "Item1", "Item2", "Item3"]) {
      expect(host.textContent!.split(name).length - 1).toBe(1);
    }
    expect(host.textContent).toContain("0 stavki");
    expect(host.textContent).toContain("Nema novih stavki.");
    expect(host.querySelector('[aria-label="Ukloni — Item0"]')).toBeNull(); // no editable row was created for a served item
  });

  it("adding one new item shows exactly it in Tekuća porudžbina; the four submitted rows stay put, unduplicated", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: servedOrder() }) : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    await click("Coffee"); // taps the menu grid card, adding a brand-new DRAFT item
    expect(host.textContent).toContain("1 stavki");
    // "Coffee" is also the only catalog item, so it always appears once more
    // in the shared menu grid — the no-duplication check is scoped to the panel.
    const panelEl = host.querySelector<HTMLElement>(".fixed.bottom-0")!;
    expect(panelEl.textContent!.split("Coffee").length - 1).toBe(1);
    for (const name of ["Item0", "Item1", "Item2", "Item3"]) {
      expect(host.textContent!.split(name).length - 1).toBe(1); // still shown exactly once, untouched
    }
  });

  it("submitting the new item moves it out of the draft panel and into the submitted section — never duplicated", async () => {
    custom = url => url === "/api/pos/orders/o5" ? response({ order: servedOrder() })
      : url === "/api/pos/orders/o5/items" ? response({ item: { ...line, id: "new-coffee" } }) : undefined;
    await render(h(OrderClient, { tableId: "5" }));
    await click("Coffee");
    custom = url => url.endsWith("/submit") ? response({ order: { ...servedOrder(), items: [...servedItems(), { ...line, id: "new-coffee", status: "SUBMITTED", submittedAt: "2026-09-13T12:00:00Z" }] } }) : undefined;
    await click("Pošalji nove stavke"); // hasEverSubmitted is already true (4 served items), so this is the label shown
    expect(host.textContent).toContain("0 stavki");
    expect(host.textContent).toContain("Nema novih stavki.");
    const panelEl = host.querySelector<HTMLElement>(".fixed.bottom-0")!;
    expect(panelEl.textContent!).not.toContain("Coffee"); // gone from the draft panel — only in "Poslato / U pripremi" now
  });

  // REGRESSION — real PREPROD QA (Task #3) found that the desktop split-view
  // panel never got a real internal scroll boundary: --waiter-header-h was
  // never actually set on a real order. Root cause: OrderClient has an EARLY
  // RETURN with its own JSX tree while `order` is still null (this exact
  // render sequence — order starts null, THEN a fetch resolves it — is
  // reproduced naturally here since fetchMock's order lookup is async), so
  // the ref'd header/root divs the CSS-variable effect depends on don't
  // exist on the FIRST commit. With an empty effect dependency array the
  // effect ran once (both refs null, no-op) and never again once the real
  // divs mounted on the second commit. This is a component-render-order
  // regression a pure geometry/computed-style check (jsdom has no real
  // layout engine) could never catch on its own — it specifically requires
  // rendering through the real loading -> loaded transition, which this
  // test does. It does NOT substitute for real-browser physical scrolling
  // proof (see the task's own real Chrome DevTools Protocol verification).
  it("sets --waiter-header-h on the root element once the order finishes loading (not stuck from the pre-order render)", async () => {
    await render(h(OrderClient, { tableId: "5" }));
    const rootEl = host.querySelector<HTMLElement>('[style*="waiter-header-h"]');
    expect(rootEl).toBeTruthy();
    // jsdom has no real layout engine (offsetHeight is always 0 there), so
    // this can only prove the effect ACTUALLY RAN and set a value — not a
    // realistic pixel measurement. The real pixel value is proven in a real
    // browser only (see this task's own CDP-based verification).
    const value = rootEl!.style.getPropertyValue("--waiter-header-h");
    expect(value.endsWith("px")).toBe(true);
  });
});

describe("P0.6 findings", () => {
  // Finding #3 — "Zauzeo kolega" must name the actual colleague.
  it("names the colleague holding a table instead of the generic message", async () => {
    custom = url => url.startsWith("/api/pos/tables") ? response({
      floors: [{ ...floors[0], tables: [floors[0].tables[0], { ...floors[0].tables[1], activeOrderOwnerId: "e2", activeOrderOwnerName: "Marko Jovanović" }] }],
    }) : undefined;
    await render(h(PosClient));
    await click("Table 12");
    expect(host.textContent).toContain("Sto koristi: Marko Jovanović");
    expect(host.textContent).not.toContain("Ovaj sto trenutno vodi drugi konobar.");
    // Ownership enforcement itself is unchanged — still no navigation.
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("does not show a colleague warning for the current waiter's own table", async () => {
    // Default fixture: table "5" is already owned by "e1", the logged-in employee.
    await render(h(PosClient));
    await click("Table 5");
    expect(host.textContent).not.toContain("Sto je zauzet");
  });

  it("falls back to the generic message when the owner's name can't be resolved, never showing a raw ID", async () => {
    custom = url => url.startsWith("/api/pos/tables") ? response({
      floors: [{ ...floors[0], tables: [floors[0].tables[0], { ...floors[0].tables[1], activeOrderOwnerId: "e2", activeOrderOwnerName: null }] }],
    }) : undefined;
    await render(h(PosClient));
    await click("Table 12");
    expect(host.textContent).toContain("Ovaj sto trenutno vodi drugi konobar.");
    expect(host.textContent).not.toContain("e2");
  });

  // Finding #1 — the [tableId] route is warmed once real table data is
  // known, without waiting for or depending on any navigation/tap.
  it("prefetches the table-order route once table data loads, before any tap", async () => {
    await render(h(PosClient));
    expect(routerPrefetch).toHaveBeenCalledWith("/waiter/tables/5");
    expect(routerPush).not.toHaveBeenCalled();
  });
});
