import { describe, it, expect } from "vitest";
import { activeOrderView } from "../../apps/web/lib/waiter-active-order";
import { createWaiterLocalDraft } from "../../apps/web/lib/waiter-local-draft";
import type { OrderData, OrderItem } from "../../apps/web/lib/waiter-order-types";

const item = (id: string, status: OrderItem["status"] = "SUBMITTED", quantity = 2): OrderItem => ({ id, status, quantity, menuItemId: "coffee", name: "Coffee", price: "200", modifiers: [], note: null });
const order = (items: OrderItem[]): OrderData => ({ id: "order", status: "SUBMITTED", guestCount: null, table: { label: "1" }, items });
describe("one active order projection", () => {
  it("derives rows/count/total from the same active identities, retaining different rounds", () => {
    const view = activeOrderView(order([item("sent"), item("sent"), item("local:x", "DRAFT", 1), item("void", "CANCELLED", 8), item("zero", "SERVED", 0)]));
    expect(view.activeItems.map(i => i.id)).toEqual(["sent", "local:x"]);
    expect(view.count).toBe(3); expect(view.total).toBe(600);
    expect(view.draftItems.map(i => i.id)).toEqual(["local:x"]);
    expect(view.sentItems.map(i => i.id)).toEqual(["sent"]);
  });
  it("quantity changes and pending removal affect count/total without touching history", () => {
    const before = order([item("sent"), item("draft", "DRAFT", 3)]);
    expect(activeOrderView(before).total).toBe(1000);
    const removed = { ...before, items: before.items.filter(i => i.id !== "draft") };
    expect(activeOrderView(removed)).toMatchObject({ count: 2, total: 400, draftItems: [] });
    expect(activeOrderView(order([item("sent"), item("draft", "DRAFT", 4)]))).toMatchObject({ count: 6, total: 1200 });
  });
  it("temp to server identity replacement does not change totals or collapse submitted rounds", () => {
    const before = activeOrderView(order([item("sent"), item("local:x", "DRAFT", 3)]));
    const after = activeOrderView(order([item("sent"), item("confirmed", "DRAFT", 3)]));
    expect(after.count).toBe(before.count); expect(after.total).toBe(before.total);
    expect(after.activeItems.map(i => i.id)).toEqual(["sent", "confirmed"]);
  });
});
describe("shared authoritative read boundary", () => {
  it("rejects reads spanning queued quantity/delete work, then accepts a fresh read", async () => {
    const draft = createWaiterLocalDraft(); draft.setOrder(order([item("sent"), item("draft", "DRAFT")]));
    const stale = draft.beginRead();
    draft.setOrder(order([item("sent")]));
    await draft.mutations.enqueue(async () => {});
    expect(draft.acceptRead(order([item("sent"), item("draft", "DRAFT")]), stale)).toBe(false);
    expect(draft.getSnapshot().order!.items).toHaveLength(1);
    await draft.flush();
    expect(draft.acceptRead(order([item("sent"), item("new", "READY")]), draft.beginRead())).toBe(true);
  });
  it("rejects reads spanning Submit even after Submit finishes", () => {
    const draft = createWaiterLocalDraft(); draft.setOrder(order([item("draft", "DRAFT")]));
    const stale = draft.beginRead(); draft.submitRevision.current++;
    draft.setOrder(order([item("draft", "SUBMITTED")]));
    expect(draft.acceptRead(order([item("draft", "DRAFT")]), stale)).toBe(false);
    expect(draft.getSnapshot().order!.items[0].status).toBe("SUBMITTED");
  });
  it("keeps read sequencing independent across waiter/table sessions with large orders", () => {
    const sessions = Array.from({ length: 3 }, () => Array.from({ length: 24 }, () => createWaiterLocalDraft()));
    for (const [waiter, tables] of sessions.entries()) for (const [table, draft] of tables.entries()) {
      const current = { ...order(Array.from({ length: 80 }, (_, i) => item(`${waiter}:${table}:${i}`))), id: `${waiter}:${table}` };
      const older = draft.beginRead(); const newer = draft.beginRead();
      expect(draft.acceptRead(current, newer)).toBe(true);
      expect(draft.acceptRead(order([]), older)).toBe(false);
      expect(activeOrderView(draft.getSnapshot().order)).toMatchObject({ count: 160, total: 32000 });
      expect(draft.getSnapshot().order!.id).toBe(`${waiter}:${table}`);
    }
  });
});
