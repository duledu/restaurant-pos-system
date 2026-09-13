import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import { orders } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";

// The integration config's mandatory safety gate runs before this file.
// Each test uses its own fixture; no Development/Production URL fallback.
let ctx: AuthContext;
let orderId: string;
let menuItemId: string;
beforeEach(async () => {
  const tenant = await prisma.tenant.create({ data: { name: "P04", slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "P04" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Test" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "5" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "waiter" } });
  const menu = await prisma.menuItem.create({ data: { restaurantId: restaurant.id, name: "Beer", slug: randomUUID(), price: "200", taxRate: "20" } });
  ctx = { employeeId: "waiter", userId: "waiter", restaurantId: restaurant.id, locationIds: [location.id], roles: ["WAITER"], permissions: new Set() };
  orderId = (await orders.openOrder(ctx, { tableId: table.id })).id;
  menuItemId = menu.id;
});
const input = () => ({ menuItemId, quantity: 1, modifierOptionIds: [], clientMutationId: randomUUID() });

describe("durable logical add idempotency", () => {
  it("retries a lost successful response without another item or audit event", async () => {
    const body = input(); const first = await orders.addItem(ctx, orderId, body); const retry = await orders.addItem(ctx, orderId, body);
    expect(retry.id).toBe(first.id);
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(1);
    expect(await prisma.orderEvent.count({ where: { orderId, type: "item_added" } })).toBe(1);
  });
  it("concurrent identical adds atomically roll back the losing item", async () => {
    const body = input(); const items = await Promise.all(Array.from({ length: 4 }, () => orders.addItem(ctx, orderId, body)));
    expect(new Set(items.map(item => item.id)).size).toBe(1);
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(1);
    expect(await prisma.orderEvent.count({ where: { orderId, type: "item_added" } })).toBe(1);
  });
  it("reuse with a different logical payload is rejected", async () => {
    const body = input(); await orders.addItem(ctx, orderId, body);
    await expect(orders.addItem(ctx, orderId, { ...body, quantity: 2 })).rejects.toThrow();
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(1);
  });
  it("removal preserves the receipt and retry never recreates the item", async () => {
    const body = input(); const added = await orders.addItem(ctx, orderId, body); await orders.removeItem(ctx, orderId, added.id);
    await expect(orders.addItem(ctx, orderId, body)).rejects.toThrow("uklonjena");
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(0);
    expect(await prisma.orderEvent.findUnique({ where: { id: body.clientMutationId } })).not.toBeNull();
  });
  it("replay still enforces restaurant and location access", async () => {
    const body = input(); await orders.addItem(ctx, orderId, body);
    await expect(orders.addItem({ ...ctx, restaurantId: randomUUID() }, orderId, body)).rejects.toThrow();
    await expect(orders.addItem({ ...ctx, locationIds: [] }, orderId, body)).rejects.toThrow();
  });
  it("new adds still validate current availability and failed validation creates no receipt", async () => {
    const body = input(); await prisma.menuItem.update({ where: { id: menuItemId }, data: { isAvailable: false } });
    await expect(orders.addItem(ctx, orderId, body)).rejects.toThrow("dostupan");
    expect(await prisma.orderEvent.findUnique({ where: { id: body.clientMutationId } })).toBeNull();
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(0);
  });
});
