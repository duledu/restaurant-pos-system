/**
 * Integration tests — KDS Aktivne / Gotove workflow.
 *
 * Invariant: An order appears in Aktivne when it has at least one
 * OrderItemStation for the given station with an ACTIVE status. It moves to
 * Gotove when ALL OrderItemStation records for that station are SERVED.
 * Kitchen and Bar complete independently. Gotove is scoped to the current
 * active shift.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { production } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

// TEST_DATABASE_URL is enforced by tests/setup/require-test-database.ts
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("[db-safety] TEST_DATABASE_URL nedostaje — require-test-database.ts je trebalo da abortuje run pre ovoga.");
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture {
  restaurantId: string;
  locationId: string;
  shiftId: string;
  tableId: string;
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "KDS tenant", slug: `kds-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "KDS Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  const shift = await prisma.shift.create({
    data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "owner-id" },
  });
  return { restaurantId: restaurant.id, locationId: location.id, shiftId: shift.id, tableId: table.id };
}

async function createOrder(f: Fixture) {
  return prisma.order.create({
    data: {
      restaurantId: f.restaurantId,
      locationId: f.locationId,
      tableId: f.tableId,
      shiftId: f.shiftId,
      openedBy: "waiter-id",
      status: "SUBMITTED",
      submittedAt: new Date(),
    },
  });
}

async function createItem(
  orderId: string,
  _restaurantId: string,
  station: "KITCHEN" | "BAR" | "KITCHEN_AND_BAR",
  quantity = 1
) {
  const item = await prisma.orderItem.create({
    data: {
      orderId,
      name: `Item ${randomUUID().slice(0, 6)}`,
      price: 100,
      taxRate: 20,
      quantity,
      preparationStation: station,
      status: "SUBMITTED",
    },
  });

  const stationsToCreate: ("KITCHEN" | "BAR")[] =
    station === "KITCHEN_AND_BAR"
      ? ["KITCHEN", "BAR"]
      : [station];

  for (const st of stationsToCreate) {
    await prisma.orderItemStation.create({
      data: { orderItemId: item.id, station: st, status: "SUBMITTED" },
    });
  }

  return item;
}

async function serveStation(itemId: string, station: "KITCHEN" | "BAR") {
  await prisma.orderItemStation.update({
    where: { orderItemId_station: { orderItemId: itemId, station } },
    data: { status: "SERVED" },
  });
}

async function setActiveStatus(itemId: string, station: "KITCHEN" | "BAR", status: "SUBMITTED" | "ACCEPTED" | "PREPARING" | "READY") {
  await prisma.orderItemStation.update({
    where: { orderItemId_station: { orderItemId: itemId, station } },
    data: { status },
  });
}

function managerCtx(f: Fixture): AuthContext {
  return {
    userId: "manager-id",
    employeeId: "manager-id",
    restaurantId: f.restaurantId,
    locationIds: [f.locationId],
    roles: ["MANAGER"],
    permissions: new Set(["production.view", "production.manage"]),
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, login_throttles");
});

// ---------------------------------------------------------------------------
// Case A: Order with at least one ACTIVE kitchen item appears in Aktivne
// ---------------------------------------------------------------------------
describe("Case A: active order appears in Aktivne", () => {
  it("order with SUBMITTED kitchen item is listed in listStationOrders", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    await createItem(order.id, f.restaurantId, "KITCHEN");

    const aktive = await production.listStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(aktive.map((o) => o.orderId)).toContain(order.id);
  });

  it("order with PREPARING kitchen item is listed in Aktivne", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item = await createItem(order.id, f.restaurantId, "KITCHEN");
    await setActiveStatus(item.id, "KITCHEN", "PREPARING");

    const aktive = await production.listStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(aktive.map((o) => o.orderId)).toContain(order.id);
  });
});

// ---------------------------------------------------------------------------
// Case B: Once ALL kitchen items are SERVED, order leaves Aktivne
// ---------------------------------------------------------------------------
describe("Case B: fully served order leaves Aktivne", () => {
  it("serving the only kitchen item removes the order from listStationOrders", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item = await createItem(order.id, f.restaurantId, "KITCHEN");

    const before = await production.listStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(before.map((o) => o.orderId)).toContain(order.id);

    await serveStation(item.id, "KITCHEN");

    const after = await production.listStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(after.map((o) => o.orderId)).not.toContain(order.id);
  });

  it("order with multiple items stays in Aktivne until all are served", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item1 = await createItem(order.id, f.restaurantId, "KITCHEN");
    const item2 = await createItem(order.id, f.restaurantId, "KITCHEN");

    await serveStation(item1.id, "KITCHEN");
    const after1 = await production.listStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(after1.map((o) => o.orderId)).toContain(order.id);

    await serveStation(item2.id, "KITCHEN");
    const after2 = await production.listStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(after2.map((o) => o.orderId)).not.toContain(order.id);
  });
});

// ---------------------------------------------------------------------------
// Case C: Served order appears in Gotove
// ---------------------------------------------------------------------------
describe("Case C: fully served order appears in Gotove", () => {
  it("serving all kitchen items moves order to listCompletedStationOrders", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item = await createItem(order.id, f.restaurantId, "KITCHEN");

    const beforeGotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(beforeGotove.map((o) => o.orderId)).not.toContain(order.id);

    await serveStation(item.id, "KITCHEN");

    const afterGotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(afterGotove.map((o) => o.orderId)).toContain(order.id);
  });

  it("completed order in Gotove contains all its items with SERVED status", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item1 = await createItem(order.id, f.restaurantId, "KITCHEN");
    const item2 = await createItem(order.id, f.restaurantId, "KITCHEN");
    await serveStation(item1.id, "KITCHEN");
    await serveStation(item2.id, "KITCHEN");

    const gotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    const found = gotove.find((o) => o.orderId === order.id);
    expect(found).toBeDefined();
    expect(found!.items).toHaveLength(2);
    expect(found!.items.every((i) => i.status === "SERVED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case D: Kitchen and Bar complete independently
// ---------------------------------------------------------------------------
describe("Case D: Kitchen and Bar complete independently", () => {
  it("serving kitchen items does not move order to Bar Gotove", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item = await createItem(order.id, f.restaurantId, "KITCHEN_AND_BAR");
    await serveStation(item.id, "KITCHEN");

    const barGotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "BAR");
    expect(barGotove.map((o) => o.orderId)).not.toContain(order.id);

    const kitchenGotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(kitchenGotove.map((o) => o.orderId)).toContain(order.id);
  });

  it("serving bar items does not remove order from Kitchen Aktivne", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item = await createItem(order.id, f.restaurantId, "KITCHEN_AND_BAR");
    await serveStation(item.id, "BAR");

    const kitchenAktive = await production.listStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(kitchenAktive.map((o) => o.orderId)).toContain(order.id);
  });

  it("KITCHEN_AND_BAR item: both stations must be served independently before each view is complete", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item = await createItem(order.id, f.restaurantId, "KITCHEN_AND_BAR");

    await serveStation(item.id, "KITCHEN");
    await serveStation(item.id, "BAR");

    const kitchenGotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    const barGotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "BAR");
    expect(kitchenGotove.map((o) => o.orderId)).toContain(order.id);
    expect(barGotove.map((o) => o.orderId)).toContain(order.id);
  });
});

// ---------------------------------------------------------------------------
// Case E: Partially served order stays in Aktivne (mixed statuses)
// ---------------------------------------------------------------------------
describe("Case E: partially served order remains in Aktivne", () => {
  it("order with one served and one active kitchen item remains in Aktivne", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item1 = await createItem(order.id, f.restaurantId, "KITCHEN");
    const item2 = await createItem(order.id, f.restaurantId, "KITCHEN");
    await serveStation(item1.id, "KITCHEN");

    const aktive = await production.listStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(aktive.map((o) => o.orderId)).toContain(order.id);

    const gotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(gotove.map((o) => o.orderId)).not.toContain(order.id);

    void item2;
  });
});

// ---------------------------------------------------------------------------
// Case F: Gotove is scoped to the current active shift
// ---------------------------------------------------------------------------
describe("Case F: Gotove scoped to current active shift", () => {
  it("served orders from a CLOSED shift are not included in Gotove", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item = await createItem(order.id, f.restaurantId, "KITCHEN");
    await serveStation(item.id, "KITCHEN");

    // Close the shift
    await prisma.shift.update({ where: { id: f.shiftId }, data: { status: "CLOSED", closedAt: new Date(), closedBy: "owner" } });

    // Open a new shift — now Gotove should only reflect the current (empty) shift
    await prisma.shift.create({
      data: { restaurantId: f.restaurantId, locationId: f.locationId, openedBy: "owner-id" },
    });

    const gotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(gotove.map((o) => o.orderId)).not.toContain(order.id);
  });

  it("returns empty list when there is no active shift", async () => {
    const f = await createFixture();
    await prisma.shift.update({ where: { id: f.shiftId }, data: { status: "CLOSED", closedAt: new Date(), closedBy: "owner" } });

    const gotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(gotove).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case G: Orders with no items for this station are excluded from both lists
// ---------------------------------------------------------------------------
describe("Case G: BAR-only orders excluded from Kitchen KDS", () => {
  it("a bar-only order is not shown in kitchen Aktivne or Gotove", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item = await createItem(order.id, f.restaurantId, "BAR");
    await serveStation(item.id, "BAR");

    const kitchenAktive = await production.listStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    const kitchenGotove = await production.listCompletedStationOrders(managerCtx(f), f.locationId, "KITCHEN");
    expect(kitchenAktive.map((o) => o.orderId)).not.toContain(order.id);
    expect(kitchenGotove.map((o) => o.orderId)).not.toContain(order.id);
  });
});

// ---------------------------------------------------------------------------
// Case H: Restaurant isolation — cannot see other restaurant's orders
// ---------------------------------------------------------------------------
describe("Case H: restaurant isolation", () => {
  it("kitchen KDS only shows orders from its own restaurant", async () => {
    const f1 = await createFixture();
    const f2 = await createFixture();

    const order2 = await createOrder(f2);
    const item2 = await createItem(order2.id, f2.restaurantId, "KITCHEN");
    void item2;

    // f1 context should not see f2's order
    const aktive = await production.listStationOrders(managerCtx(f1), f1.locationId, "KITCHEN");
    expect(aktive.map((o) => o.orderId)).not.toContain(order2.id);

    const gotove = await production.listCompletedStationOrders(managerCtx(f1), f1.locationId, "KITCHEN");
    expect(gotove.map((o) => o.orderId)).not.toContain(order2.id);
  });
});

// ---------------------------------------------------------------------------
// Case I: Real-time move — serving last item atomically moves order from
//          Aktivne to Gotove without any intermediate state where it's in both
// ---------------------------------------------------------------------------
describe("Case I: atomic move from Aktivne to Gotove", () => {
  it("order is either in Aktivne or Gotove — never in both simultaneously", async () => {
    const f = await createFixture();
    const order = await createOrder(f);
    const item = await createItem(order.id, f.restaurantId, "KITCHEN");

    const ctx = managerCtx(f);

    // Before serving: in Aktivne, not in Gotove
    const [aktive1, gotove1] = await Promise.all([
      production.listStationOrders(ctx, f.locationId, "KITCHEN"),
      production.listCompletedStationOrders(ctx, f.locationId, "KITCHEN"),
    ]);
    expect(aktive1.map((o) => o.orderId)).toContain(order.id);
    expect(gotove1.map((o) => o.orderId)).not.toContain(order.id);

    await serveStation(item.id, "KITCHEN");

    // After serving: in Gotove, not in Aktivne
    const [aktive2, gotove2] = await Promise.all([
      production.listStationOrders(ctx, f.locationId, "KITCHEN"),
      production.listCompletedStationOrders(ctx, f.locationId, "KITCHEN"),
    ]);
    expect(aktive2.map((o) => o.orderId)).not.toContain(order.id);
    expect(gotove2.map((o) => o.orderId)).toContain(order.id);
  });
});
