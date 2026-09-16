import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createWaiterLocalDraft } from "../../apps/web/lib/waiter-local-draft";
import type { MenuItem } from "../../apps/web/lib/waiter-menu";
import type { OrderItem } from "../../apps/web/lib/waiter-order-types";

const menu = (id = "beer"): MenuItem => ({ id, name: id, price: "200", categoryId: "drinks", modifierGroups: [], stock: null, recipeAvailability: null, availability: { isAvailable: true, reasonCode: null, reasonLabel: null } });
const item = (id = "real1", menuItemId = "beer", quantity = 1): OrderItem => ({ id, menuItemId, name: menuItemId, price: "210", quantity, note: null, status: "DRAFT", modifiers: [] });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
function session() { const draft = createWaiterLocalDraft(); draft.setOrder({ id: "o1", status: "DRAFT", guestCount: null, table: { label: "5" }, items: [] }); return draft; }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("instant local draft with delayed network", () => {
  it("first add is visible synchronously before any request/response and reconciles authoritative price", async () => {
    const pending = deferred<ReturnType<typeof response>>(); const fetch = vi.fn(() => pending.promise); vi.stubGlobal("fetch", fetch);
    const draft = session(); draft.add(menu(), []);
    expect(draft.getSnapshot().order!.items).toMatchObject([{ id: expect.stringMatching(/^local:/), quantity: 1, price: "200.00" }]);
    expect(fetch).not.toHaveBeenCalled(); await tick(); expect(fetch).toHaveBeenCalledTimes(1);
    pending.resolve(response({ item: item() })); await draft.flush();
    expect(draft.getSnapshot().order!.items).toEqual([{ ...item(), localStatus: undefined }]);
  });
  it("a definite rejection removes only its temporary line and blocks Submit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({}, 400))); const draft = session();
    draft.setOrder(previous => ({ ...previous!, items: [item("other", "water")] })); draft.add(menu(), []);
    await expect(draft.flush()).rejects.toThrow(); expect(draft.getSnapshot().order!.items.map(i => i.id)).toEqual(["other"]);
    expect(draft.getSnapshot().error).toContain("Nije moguće dodati");
  });
  it("same item fast taps immediately increment one pending row", async () => {
    const pending = deferred<ReturnType<typeof response>>(); const fetch = vi.fn((_url, options) => options.method === "POST" ? pending.promise : Promise.resolve(response({ item: item("real1", "beer", 3) }))); vi.stubGlobal("fetch", fetch);
    const draft = session(); draft.add(menu(), []);
    for (let i = 0; i < 2; i++) { const found = draft.add(menu(), [])!; draft.changePending(found.id, found.quantity + 1); }
    expect(draft.getSnapshot().order!.items).toMatchObject([{ quantity: 3 }]);
    pending.resolve(response({ item: item() })); await draft.flush();
    expect(draft.getSnapshot().order!.items).toMatchObject([{ id: "real1", quantity: 3 }]);
    expect(fetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ quantity: 3 });
  });
  it("plus then minus before create confirmation preserves latest quantity", async () => {
    const pending = deferred<ReturnType<typeof response>>(); const fetch = vi.fn(async () => pending.promise); vi.stubGlobal("fetch", fetch);
    const draft = session(); draft.add(menu(), []); const id = draft.getSnapshot().order!.items[0].id;
    draft.changePending(id, 2); draft.changePending(id, 1);
    pending.resolve(response({ item: item() })); await draft.flush(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(draft.getSnapshot().order!.items[0].quantity).toBe(1);
  });
  it("remove before create confirmation sends DELETE and leaves no row", async () => {
    const pending = deferred<ReturnType<typeof response>>(); const fetch = vi.fn((_url, options) => options.method === "POST" ? pending.promise : Promise.resolve(response({ ok: true }))); vi.stubGlobal("fetch", fetch);
    const draft = session(); draft.add(menu(), []); draft.changePending(draft.getSnapshot().order!.items[0].id, 0);
    expect(draft.getSnapshot().order!.items).toEqual([]);
    pending.resolve(response({ item: item() })); await draft.flush();
    expect(fetch.mock.calls[1][0]).toBe("/api/pos/orders/o1/items/real1"); expect(fetch.mock.calls[1][1].method).toBe("DELETE");
    expect(draft.pending).toBe(false); expect(draft.getSnapshot().order!.items).toEqual([]);
  });
  it("a newer quantity while PATCH is in flight cannot jump backwards", async () => {
    const patch = deferred<ReturnType<typeof response>>(); let patches = 0;
    vi.stubGlobal("fetch", vi.fn((_url, options) => options.method === "POST" ? Promise.resolve(response({ item: item() })) : ++patches === 1 ? patch.promise : Promise.resolve(response({ item: item("real1", "beer", 3) }))));
    const draft = session(); draft.add(menu(), []); const id = draft.getSnapshot().order!.items[0].id; draft.changePending(id, 2);
    await tick(); draft.changePending(id, 3); patch.resolve(response({ item: item("real1", "beer", 2) }));
    await draft.flush(); expect(draft.getSnapshot().order!.items[0].quantity).toBe(3); expect(patches).toBe(2);
  });
  it("different modifier selections remain separate and include local display price", async () => {
    const drink = { ...menu(), modifierGroups: [{ group: { id: "g", name: "Size", required: false, minSelect: 0, maxSelect: 1, isActive: true, options: [{ id: "large", name: "Large", priceDelta: "50", isActive: true }] } }] };
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const draft = session(); draft.add(drink, []); draft.add(drink, ["large"]);
    expect(draft.getSnapshot().order!.items.map(i => i.price)).toEqual(["200.00", "250.00"]);
    expect(draft.add(drink, ["large"])?.quantity).toBe(1);
  });
  it("2 Rakija + 2 Pivo + 1 Kisela are immediately visible with awkward delayed confirmations", async () => {
    const responses = [deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>(), deferred<ReturnType<typeof response>>()];
    const authoritative = new Map<string, OrderItem>(); let creates = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (options.method === "POST") { const result = await responses[creates++].promise; const body = await result.json() as { item: OrderItem }; authoritative.set(body.item.id, { ...body.item }); return result; }
      const id = url.split("/").at(-1)!; const quantity = JSON.parse(options.body).quantity; authoritative.get(id)!.quantity = quantity; return response({ item: { ...authoritative.get(id)! } });
    }));
    const draft = session();
    for (const id of ["Rakija", "Rakija", "Pivo", "Pivo", "Kisela"]) { const found = draft.add(menu(id), []); if (found) draft.changePending(found.id, found.quantity + 1); }
    expect(draft.getSnapshot().order!.items.map(i => [i.name, i.quantity])).toEqual([["Rakija", 2], ["Pivo", 2], ["Kisela", 1]]);
    responses[2].resolve(response({ item: item("r3", "Kisela") })); responses[1].resolve(response({ item: item("r2", "Pivo") }));
    responses[0].resolve(response({ item: item("r1", "Rakija") })); await draft.flush();
    expect(draft.getSnapshot().order!.items.map(i => [i.name, i.quantity])).toEqual([["Rakija", 2], ["Pivo", 2], ["Kisela", 1]]);
    expect([...authoritative.values()].map(i => i.quantity)).toEqual([2, 2, 1]);
  });
  it("lost create response retries the exact same logical mutation ID", async () => {
    let written: OrderItem | null = null; const ids: string[] = []; let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => { const body = JSON.parse(options.body); ids.push(body.clientMutationId); if (!written) { written = item(); writes++; throw new TypeError("response lost after commit"); } return response({ item: written }); }));
    const draft = session(); draft.add(menu(), []); await draft.flush(); expect(writes).toBe(1); expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  });
  it("persistent network failure keeps a retryable unresolved line and prevents Submit until resolved", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("offline"); }); vi.stubGlobal("fetch", fetch);
    const draft = session(); draft.add(menu(), []); await expect(draft.flush()).rejects.toThrow();
    expect(draft.retryable).toBe(true); expect(draft.getSnapshot().order!.items[0].localStatus).toBe("failed");
    await expect(draft.flush()).rejects.toThrow(); const originalBody = fetch.mock.calls[0][1].body;
    fetch.mockImplementation(async () => response({ item: item() })); draft.retry(); await draft.flush();
    expect(fetch.mock.calls.at(-1)![1].body).toBe(originalBody); expect(draft.pending).toBe(false);
  });
  it("navigation/unsubscription does not cancel a queued create", async () => {
    const pending = deferred<ReturnType<typeof response>>(); vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const draft = session(); const unsubscribe = draft.subscribe(vi.fn()); draft.add(menu(), []); unsubscribe();
    pending.resolve(response({ item: item() })); await draft.flush(); expect(draft.getSnapshot().order!.items[0].id).toBe("real1");
  });
  it("unknown availability never inserts a local line", () => {
    const draft = session(); draft.add({ ...menu(), availability: null }, []); expect(draft.getSnapshot().order!.items).toEqual([]);
  });
  // Physical PREPROD waiter crash fix — order-service.ts updateItem (PATCH
  // quantity) used to return an OrderItem missing its `modifiers` relation.
  // sendCreation merges exactly that PATCH response into live order state
  // when a quantity change races an in-flight item creation (this exact
  // sequence: add, create resolves, THEN a quantity change fires a PATCH).
  // The old code (`if (result.item?.id) op.realItem = result.item;`) would
  // adopt the incomplete response, writing `modifiers: undefined` into the
  // rendered order and crashing every `.modifiers.length` read in
  // order-client.tsx (DraftRow/HistoryRow) with "Cannot read properties of
  // undefined (reading 'length')". This proves the fixed guard rejects an
  // incomplete PATCH response instead of corrupting state, independent of
  // the paired server-side fix (menu-modifiers.test.ts covers that half).
  it("a malformed PATCH response missing `modifiers` never corrupts the rendered item (defense in depth)", async () => {
    const withModifiers = { ...item("real1", "beer", 1), modifiers: [{ id: "m1", modifierOptionId: "opt1", groupName: "Dodaci", optionName: "Slanina", priceDelta: "150" }] };
    const pending = deferred<ReturnType<typeof response>>();
    vi.stubGlobal("fetch", vi.fn((_url, options) => {
      if (options.method === "POST") return pending.promise;
      // Simulates the old server bug: `modifiers` relation not included in the PATCH response.
      const malformed = { ...withModifiers, quantity: JSON.parse(options.body).quantity } as Record<string, unknown>;
      delete malformed.modifiers;
      return Promise.resolve(response({ item: malformed }));
    }));
    const draft = session();
    draft.add(menu(), []); // op.quantity = 1, POST in flight
    const id = draft.getSnapshot().order!.items[0].id;
    draft.changePending(id, 2); // desired quantity changes WHILE the create is still in flight (the real race)
    pending.resolve(response({ item: withModifiers })); // create resolves with server quantity 1 -> triggers the confirming PATCH above
    await draft.flush();
    const finalItem = draft.getSnapshot().order!.items[0];
    expect(finalItem.quantity).toBe(2); // quantity still tracked correctly...
    expect(Array.isArray(finalItem.modifiers)).toBe(true); // ...but modifiers was never overwritten with undefined.
    expect(finalItem.modifiers).toEqual(withModifiers.modifiers);
  });

  it("failure reconciliation of a confirmed line preserves queued temporary lines", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const draft = session(); draft.setOrder(previous => ({ ...previous!, items: [item("water", "water", 2)] }));
    draft.add(menu(), []);
    draft.reconcileItem({ ...draft.getSnapshot().order!, items: [item("water", "water", 1)] }, "water");
    expect(draft.getSnapshot().order!.items.map(i => [i.menuItemId, i.quantity])).toEqual([["water", 1], ["beer", 1]]);
    expect(draft.getSnapshot().order!.items[1].id).toMatch(/^local:/);
  });
});
