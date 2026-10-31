import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import { orders, transfers } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";

let ctx: AuthContext;
let tableId: string;
beforeEach(async () => {
  const tenant = await prisma.tenant.create({ data: { name: "Concurrent POS", slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Concurrent POS" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Test" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  tableId = (await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "1" } })).id;
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "waiter" } });
  ctx = { employeeId: "waiter", userId: "waiter", restaurantId: restaurant.id, locationIds: [location.id], roles: ["WAITER"], permissions: new Set() };
});

describe("serialized table creation", () => {
  it("concurrent terminals and a lost-response retry return one complete order and one event", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => orders.openOrder(ctx, { tableId })));
    expect(new Set(results.map(order => order.id)).size).toBe(1);
    for (const order of results) {
      expect(order.items).toEqual([]);
      expect(order.table.id).toBe(tableId);
      expect(order.table.status).toBe("OCCUPIED");
    }
    const retry = await orders.openOrder(ctx, { tableId });
    expect(retry.id).toBe(results[0].id);
    expect(await prisma.order.count({ where: { tableId } })).toBe(1);
    expect(await prisma.orderEvent.count({ where: { orderId: retry.id, type: "order_opened" } })).toBe(1);
  });

  it("competing waiters cannot obtain or duplicate each other's draft", async () => {
    const results = await Promise.allSettled([
      orders.openOrder(ctx, { tableId }),
      orders.openOrder({ ...ctx, employeeId: "other" }, { tableId }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await prisma.order.count({ where: { tableId } })).toBe(1);
  });

  it("rejects another location and missing shift without creating an order", async () => {
    await expect(orders.openOrder({ ...ctx, locationIds: [] }, { tableId })).rejects.toThrow();
    await prisma.shift.updateMany({ where: { restaurantId: ctx.restaurantId }, data: { status: "CLOSED" } });
    await expect(orders.openOrder(ctx, { tableId })).rejects.toThrow("Nema aktivne smene");
    expect(await prisma.order.count({ where: { tableId } })).toBe(0);
  });

  it("serializes a new table open against the transfer creation path", async () => {
    const destination = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: tableId } });
    const sourceTable = await prisma.restaurantTable.create({ data: { floorId: destination.floorId, label: "Source" } });
    const source = await orders.openOrder(ctx, { tableId: sourceTable.id });
    const menuItem = await prisma.menuItem.create({ data: { restaurantId: ctx.restaurantId, name: "Coffee", slug: randomUUID(), price: 200, taxRate: 20 } });
    await prisma.order.update({ where: { id: source.id }, data: { status: "SUBMITTED" } });
    const item = await prisma.orderItem.create({ data: { orderId: source.id, menuItemId: menuItem.id, name: menuItem.name, price: 200, taxRate: 20, quantity: 1, status: "SUBMITTED" } });
    const outcomes = await Promise.allSettled([
      orders.openOrder(ctx, { tableId }),
      transfers.transferOrderItems(ctx, source.id, { destinationTableId: tableId, lines: [{ orderItemId: item.id, quantity: 1 }] }),
    ]);
    // If opening wins, transfer safely rejects the destination draft. If
    // transfer wins, opening reuses that submitted order. Neither can duplicate it.
    expect(outcomes[0].status).toBe("fulfilled");
    const active = await prisma.order.findMany({ where: { tableId, status: { notIn: ["COMPLETED", "CANCELLED"] } } });
    expect(active).toHaveLength(1);
    if (outcomes[0].status === "fulfilled") expect(outcomes[0].value.id).toBe(active[0].id);
    expect(await prisma.orderItem.count({ where: { menuItemId: menuItem.id } })).toBe(1);
  });
});
