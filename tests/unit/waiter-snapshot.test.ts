import { describe, expect, it, vi } from 'vitest';
import { shareWaiterSnapshot } from '../../apps/web/lib/waiter-snapshot';
import { createWaiterLocalDraft } from '../../apps/web/lib/waiter-local-draft';
import type { OrderData } from '../../apps/web/lib/waiter-order-types';

describe('waiter refresh structural sharing', () => {
  it('retains identical JSON snapshots and only changes the affected nested row', () => {
    const previous = { floors: [{ tables: [{ id: '1', readyItems: [] }, { id: '2', readyItems: [] }] }] };
    expect(shareWaiterSnapshot(previous, structuredClone(previous))).toBe(previous);
    const next = { floors: [{ tables: [{ id: '1', readyItems: [{ id: 'ready' }] }, { id: '2', readyItems: [] }] }] };
    const shared = shareWaiterSnapshot(previous as typeof next, next);
    expect(shared.floors[0].tables[0]).toEqual(next.floors[0].tables[0]);
    expect(shared.floors[0].tables[1]).toBe(previous.floors[0].tables[1]);
    expect(previous.floors[0].tables[0].readyItems).toEqual([]);
  });
  it('never suppresses added/removed fields, array removals, status, or price changes', () => {
    const previous = { id: '1', status: 'READY', price: '200', note: 'original', modifiers: [{ id: 'lemon' }] };
    const next = { id: '1', status: 'SERVED', price: '220', modifiers: [], newServerField: true };
    expect(shareWaiterSnapshot<Record<string, unknown>>(previous, next)).toEqual(next);
    expect(shareWaiterSnapshot({ a: null }, { a: {} })).toEqual({ a: {} });
  });
  it('does not notify subscribers for an identical accepted order but delivers READY changes', () => {
    const draft = createWaiterLocalDraft();
    const order = { id: 'o1', locationId: 'l', status: 'SUBMITTED', table: { label: '1' }, items: [{ id: 'i', menuItemId: 'm', name: 'Drink', quantity: 1, price: '200', status: 'SUBMITTED', note: null, modifiers: [] }] } as OrderData;
    draft.setOrder(order); const listener = vi.fn(); draft.subscribe(listener);
    expect(draft.acceptRead(structuredClone(order), draft.beginRead())).toBe(true);
    expect(listener).not.toHaveBeenCalled(); expect(draft.getSnapshot().order).toBe(order);
    const next = structuredClone(order); next.items[0].status = 'READY';
    expect(draft.acceptRead(next, draft.beginRead())).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1); expect(draft.getSnapshot().order?.items[0].status).toBe('READY');
  });
});
