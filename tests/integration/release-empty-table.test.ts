/**
 * releaseEmptyTable ("Oslobodi sto") — konobar zatvara PRAZNU, nikad
 * poslatu porudžbinu (gost otišao pre naručivanja) bez menadžera. Namerno
 * odvojeno od cancelAbandonedOrder (void-service.ts, menadžment-only,
 * dozvoljava i VEĆ POSLATE porudžbine uz obavezan razlog) — ova funkcija je
 * ograničena ISKLJUČIVO na status DRAFT, ista DRAFT-vlasništvo pravila kao
 * svaka druga korpa izmena, bez razloga.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { orders } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  menuItemId: string;
}

function context(fixture: Pick<Fixture, "restaurantId" | "locationId">, role: string, employeeId: string): AuthContext {
  return { userId: employeeId, employeeId, restaurantId: fixture.restaurantId, locationIds: [fixture.locationId], roles: [role], permissions: new Set() };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Release tenant", slug: `release-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T9" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const menuItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Burger", slug: `burger-${randomUUID()}`, price: "1200.00", taxRate: "20", preparationStation: "KITCHEN" },
  });

  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, menuItemId: menuItem.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, login_throttles");
});

describe("releaseEmptyTable: core behavior", () => {
  it("1: releases a genuinely empty (no items at all) DRAFT order and frees the table", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    const result = await orders.releaseEmptyTable(waiter, order.id);
    expect(result).toEqual({ orderId: order.id, status: "CANCELLED" });

    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloadedOrder.status).toBe("CANCELLED");
  });

  it("1b: releases a DRAFT order that still has unsent DRAFT items, cancelling them (no silent deletion of the Order/OrderItem rows)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 2 });

    await orders.releaseEmptyTable(waiter, order.id);

    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloadedItem.status).toBe("CANCELLED"); // preserved row, not deleted
  });

  it("2: table becomes FREE after release", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const before = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(before.status).toBe("OCCUPIED");

    await orders.releaseEmptyTable(waiter, order.id);

    const after = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(after.status).toBe("FREE");
  });

  it("3: a released order is not restored as the table's active order — reopening the table starts a genuinely NEW order", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.releaseEmptyTable(waiter, order.id);

    const reopened = await orders.openOrder(waiter, { tableId: fixture.tableId });
    expect(reopened.id).not.toBe(order.id);
    expect(reopened.status).toBe("DRAFT");
  });

  it("10: preserves an auditable trail (order_opened -> order_released_empty) instead of deleting history", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.releaseEmptyTable(waiter, order.id);

    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["order_opened", "order_released_empty"]);
  });

  it("11: table isolation — releasing one table's order never touches a sibling table", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const floor = await prisma.floor.findFirstOrThrow({ where: { locationId: fixture.locationId } });
    const otherTable = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T10" } });
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const otherOrder = await orders.openOrder(waiter, { tableId: otherTable.id });

    await orders.releaseEmptyTable(waiter, order.id);

    const otherReloaded = await prisma.order.findUniqueOrThrow({ where: { id: otherOrder.id } });
    expect(otherReloaded.status).toBe("DRAFT");
    const otherTableReloaded = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: otherTable.id } });
    expect(otherTableReloaded.status).toBe("OCCUPIED");
  });
});

describe("releaseEmptyTable: rejections", () => {
  it("4: rejects release once ANY item has been submitted — the Void/otkazivanje workflow must be used instead", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await expect(orders.releaseEmptyTable(waiter, submitted.id)).rejects.toThrow("već poslata");

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(reloaded.status).toBe("SUBMITTED"); // untouched
    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("OCCUPIED"); // untouched
  });

  it("5: rejects once Kitchen/Bar work exists (order status has advanced past SUBMITTED)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await expect(orders.releaseEmptyTable(waiter, submitted.id)).rejects.toThrow("već poslata");
  });

  it("6: rejects if the order somehow already has a Payment row, even defensively", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    // Defensive-only scenario (a DRAFT order cannot normally reach billing) —
    // simulate directly to prove the belt-and-suspenders guard fires.
    await prisma.payment.create({
      data: { orderId: order.id, restaurantId: fixture.restaurantId, locationId: fixture.locationId, shiftId: order.shiftId, method: "CASH", amount: "0", tenderedAmount: "0", completedBy: "waiter-1" },
    });

    await expect(orders.releaseEmptyTable(waiter, order.id)).rejects.toThrow("plaćanje");
  });

  it("rejects a different (non-owning) waiter — same DRAFT-ownership rule as every other cart edit", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const otherWaiter = context(fixture, "WAITER", "waiter-2");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    await expect(orders.releaseEmptyTable(otherWaiter, order.id)).rejects.toBeInstanceOf(ForbiddenError);

    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("OCCUPIED");
  });

  it("allows management to release a DRAFT order they did not open", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    await expect(orders.releaseEmptyTable(manager, order.id)).resolves.toEqual({ orderId: order.id, status: "CANCELLED" });
  });
});

describe("releaseEmptyTable: race / safety", () => {
  it("8: a concurrent Submit right before release wins — the server never releases a table with newly submitted work", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });

    // Submit lands first (simulates Waiter B submitting a split-second before
    // Waiter A's release reaches the server).
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await expect(orders.releaseEmptyTable(waiter, order.id)).rejects.toThrow();

    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("OCCUPIED"); // never falsely freed
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe("SUBMITTED"); // the submitted work is never lost
  });

  it("9: repeated release / double tap on the same order is safe — only the first commits", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    const results = await Promise.allSettled([
      orders.releaseEmptyTable(waiter, order.id),
      orders.releaseEmptyTable(waiter, order.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe("CANCELLED");
  });

  it("9b: releasing an already-released order a second time (sequential double tap) fails safely without re-freeing/re-cancelling", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.releaseEmptyTable(waiter, order.id);

    await expect(orders.releaseEmptyTable(waiter, order.id)).rejects.toThrow();
  });
});
