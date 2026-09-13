import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@rcs/auth';
const mocks = vi.hoisted(() => ({
  db: { order: { findFirst: vi.fn() }, $transaction: vi.fn() },
  audit: vi.fn(), publish: vi.fn(), dispatch: vi.fn(),
}));
vi.mock('@rcs/db', () => ({ prisma: mocks.db, Prisma: {} }));
vi.mock('../../packages/domain/audit/audit-service', () => ({ recordAuditEntry: mocks.audit }));
vi.mock('../../packages/domain/realtime/sse-publisher', () => ({ ssePublisher: { publish: mocks.publish } }));
vi.mock('../../packages/domain/printing/print-service', () => ({ dispatchStationPrintJobs: mocks.dispatch }));
vi.mock('../../packages/domain/menu/availability-service', () => ({ getBlockedAvailability: async () => new Map() }));
vi.mock('../../packages/domain/inventory/ingredient-service', () => ({ assertIngredientStockAvailable: vi.fn() }));
vi.mock('../../packages/domain/menu/modifier-service', () => ({ getModifierGroupsForMenuItem: vi.fn(), validateAndPriceModifierSelection: vi.fn() }));
vi.mock('../../packages/domain/shifts/shift-service', () => ({ getActiveShift: vi.fn() }));
vi.mock('../../packages/domain/tables/table-service', () => ({ getTable: vi.fn() }));
import { submitOrder } from '../../packages/domain/orders/order-service';
const ctx = { userId: 'u', employeeId: 'e', restaurantId: 'r', locationIds: ['l'], roles: ['WAITER'], permissions: new Set() } as AuthContext;
const order = { id: 'o', tableId: 't', locationId: 'l', status: 'SUBMITTED', openedBy: 'e' };
const drafts = ['KITCHEN', 'BAR'].map((preparationStation, i) => ({ id: `new-${i}`, menuItemId: null, name: 'Historical menu item', quantity: 1, preparationStation }));
function transaction() {
  return { orderItem: { findMany: vi.fn().mockResolvedValue(drafts), updateMany: vi.fn() }, menuItem: { findMany: vi.fn() }, orderItemModifier: { findMany: vi.fn().mockResolvedValue([]) }, orderItemStation: { createMany: vi.fn() }, orderEvent: { create: vi.fn() } };
}
beforeEach(() => { vi.resetAllMocks(); mocks.db.order.findFirst.mockResolvedValue({ ...order, items: [] }); });
describe('real Submit service boundary with database and dispatch mocked', () => {
  it('commits only selected draft IDs and routes both stations before downstream acknowledgement', async () => {
    const tx = transaction(); let release!: () => void; let transactionFinished!: () => void;
    const reachedCommit = new Promise<void>(r => { transactionFinished = r; });
    const commit = new Promise<void>(r => { release = r; });
    mocks.db.$transaction.mockImplementation(async fn => { const result = await fn(tx); transactionFinished(); await commit; return result; });
    let completed = false;
    const request = submitOrder(ctx, 'o', { idempotencyKey: 'round-key' }).then(() => { completed = true; });
    await reachedCommit;
    expect(completed).toBe(false); expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(tx.orderItem.findMany).toHaveBeenCalledWith({ where: { orderId: 'o', status: 'DRAFT' } });
    expect(tx.orderItemStation.createMany).toHaveBeenCalledWith({ data: [
      { orderItemId: 'new-0', station: 'KITCHEN', status: 'SUBMITTED' },
      { orderItemId: 'new-1', station: 'BAR', status: 'SUBMITTED' },
    ] });
    release(); await request;
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(ctx, 'o', { orderItemIds: ['new-0', 'new-1'], dispatchKeySuffix: 'round-key' });
    expect(mocks.audit).toHaveBeenCalledTimes(1); expect(tx.orderEvent.create).toHaveBeenCalledTimes(1);
    tx.orderItem.findMany.mockResolvedValue([]);
    await submitOrder(ctx, 'o', { idempotencyKey: 'round-key' });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1); expect(mocks.audit).toHaveBeenCalledTimes(1); expect(tx.orderItemStation.createMany).toHaveBeenCalledTimes(1);
  });
  it('does not publish or dispatch on transaction failure', async () => {
    mocks.db.$transaction.mockRejectedValue(new Error('commit failed'));
    await expect(submitOrder(ctx, 'o', { idempotencyKey: 'round-key' })).rejects.toThrow('commit failed');
    expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
});
