import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@rcs/auth";
const db = vi.hoisted(() => ({ order: { findFirst: vi.fn() }, restaurantTable: { findFirst: vi.fn() }, shift: { findFirst: vi.fn() } }));
vi.mock("@rcs/db", () => ({ prisma: db }));
import { getActiveTableOrder } from "../../packages/domain/orders/active-table-order";
const ctx = { userId: "u", employeeId: "e", restaurantId: "r", locationIds: ["l"], roles: ["WAITER"], permissions: new Set() } as AuthContext;
beforeEach(() => { vi.clearAllMocks(); db.shift.findFirst.mockResolvedValue({ id: "s" }); db.restaurantTable.findFirst.mockResolvedValue({ id: "t", label: "1", isActive: true, floor: { locationId: "l" } }); });
describe("read-only active-table inspection", () => {
  it("returns the occupied order and complete modifier rows from one order query", async () => {
    const order = { id: "o", tableId: "t", locationId: "l", status: "SUBMITTED", items: [{ id: "i", modifiers: [{ modifierOptionId: "lemon" }] }] };
    db.order.findFirst.mockResolvedValue(order);
    expect(await getActiveTableOrder(ctx, "t")).toEqual({ table: { id: "t", label: "1", locationId: "l" }, order });
    expect(db.order.findFirst).toHaveBeenCalledTimes(1);
    expect(db.order.findFirst).toHaveBeenCalledWith({
      where: { restaurantId: "r", tableId: "t", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      include: { items: { include: { modifiers: { orderBy: { sortOrder: "asc" } } }, orderBy: { createdAt: "asc" } }, table: true },
    });
  });
  it("returns null for empty tables without a create, transaction, shift mutation or audit write", async () => {
    // No write methods exist on this mock: an accidental write fails the test.
    db.order.findFirst.mockResolvedValue(null);
    expect((await getActiveTableOrder(ctx, "t")).order).toBeNull();
    expect(db.order.findFirst).toHaveBeenCalledTimes(1);
  });
  it("rejects other locations before reading order contents", async () => {
    db.restaurantTable.findFirst.mockResolvedValue({ id: "t", isActive: true, floor: { locationId: "other" } });
    await expect(getActiveTableOrder(ctx, "t")).rejects.toThrow();
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });
  it("retains draft ownership authorization", async () => {
    db.order.findFirst.mockResolvedValue({ locationId: "l", status: "DRAFT", openedBy: "other" });
    await expect(getActiveTableOrder(ctx, "t")).rejects.toThrow();
  });
  it("retains the active-shift gate before making a table usable", async () => {
    db.shift.findFirst.mockResolvedValue(null);
    await expect(getActiveTableOrder(ctx, "t")).rejects.toThrow("Nema aktivne smene");
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });
});
