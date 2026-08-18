import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, voids } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  kitchenItemId: string;
  noStationItemId: string;
}

function context(fixture: Fixture, role: string, employeeId: string): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(["orders.print"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Cancel tenant", slug: `cancel-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T12" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const kitchenItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Pljeskavica",
      slug: `pljeskavica-${randomUUID()}`,
      price: "800.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });
  const noStationItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Voda",
      slug: `voda-${randomUUID()}`,
      price: "150.00",
      taxRate: "20",
      preparationStation: "NONE",
    },
  });
  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, kitchenItemId: kitchenItem.id, noStationItemId: noStationItem.id };
}

const VALID_EXPLANATION = "Gost je otkazao stavku pre nego što je kuhinja počela pripremu, storniramo.";

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

afterAll(async () => prisma.$disconnect());

describe("cancellation ticket (STORNO): only for items that actually reached a station", () => {
  it("creates a correct STORNO print job when a fully-voided item had already been dispatched to the kitchen", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 1,
      reasonCode: "WRONG_ITEM",
      explanation: VALID_EXPLANATION,
    });

    const stornoJobs = await prisma.printJob.findMany({
      where: { orderId: submitted.id, dispatchKey: { startsWith: "void:" } },
    });
    expect(stornoJobs).toHaveLength(1);
    expect(stornoJobs[0].type).toBe("KITCHEN");
    const content = stornoJobs[0].content as { kind: string; items: { name: string; quantity: number }[]; tableLabel: string };
    expect(content.kind).toBe("STORNO");
    expect(content.tableLabel).toBe("T12");
    expect(content.items).toEqual([{ quantity: 1, name: "Pljeskavica" }]);
  });

  it("does not create a STORNO ticket for a partial void — the item is still being prepared in reduced quantity", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 2 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 1,
      reasonCode: "WRONG_QUANTITY",
      explanation: VALID_EXPLANATION,
    });

    const stornoJobs = await prisma.printJob.findMany({
      where: { orderId: submitted.id, dispatchKey: { startsWith: "void:" } },
    });
    expect(stornoJobs).toHaveLength(0);
  });

  it("does not create a STORNO ticket for an item that never reached any station (preparationStation NONE)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.noStationItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    // NONE-station stavka nema OrderItemStation redove uopšte.
    expect(await prisma.orderItemStation.count({ where: { orderItemId: item.id } })).toBe(0);

    await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 1,
      reasonCode: "OTHER",
      explanation: VALID_EXPLANATION,
    });

    const stornoJobs = await prisma.printJob.findMany({
      where: { orderId: submitted.id, dispatchKey: { startsWith: "void:" } },
    });
    expect(stornoJobs).toHaveLength(0);
  });

  it("respects existing void permissions — a waiter cannot trigger a cancellation ticket by voiding directly", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await expect(
      voids.voidOrderItem(waiter, submitted.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: VALID_EXPLANATION })
    ).rejects.toThrow();

    const stornoJobs = await prisma.printJob.findMany({
      where: { orderId: submitted.id, dispatchKey: { startsWith: "void:" } },
    });
    expect(stornoJobs).toHaveLength(0);
  });
});
