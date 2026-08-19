import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { resetPrismaTestTables } from "../setup/reset-test-db";
import {
  ForbiddenError,
  UnauthorizedError,
  createSessionToken,
  hashPin,
  requireAuth,
  type AuthContext,
} from "@rcs/auth";
import { orders, production } from "@rcs/domain";
import { POST as pinLogin } from "../../apps/web/app/api/auth/pin-login/route";
import { getActiveLoginThrottle, recordFailedLogin } from "../../apps/web/lib/login-throttle";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  tableId: string;
  otherLocationTableId: string;
  otherRestaurantTableId: string;
  menuItems: Record<"KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE", string>;
}

function context(fixture: Fixture, role: string, employeeId: string, locationIds = [fixture.locationId]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds,
    roles: [role],
    permissions: new Set(
      ["KITCHEN", "BAR"].includes(role) || ["OWNER", "ADMIN", "MANAGER"].includes(role)
        ? ["production.view", "production.manage"]
        : []
    ),
  };
}

async function createLocation(restaurantId: string, name: string) {
  const location = await prisma.location.create({ data: { restaurantId, name } });
  const floor = await prisma.floor.create({ data: { restaurantId, locationId: location.id, name: `${name} floor` } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: `${name} table` } });
  return { location, table };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Phase 1 tenant", slug: `phase-1-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const primary = await createLocation(restaurant.id, "Primary");
  const otherLocation = await createLocation(restaurant.id, "Other");
  const foreign = await createLocation(otherRestaurant.id, "Foreign");

  await prisma.shift.create({
    data: { restaurantId: restaurant.id, locationId: primary.location.id, openedBy: "manager" },
  });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const menuItems = {} as Fixture["menuItems"];
  for (const station of ["KITCHEN", "BAR", "KITCHEN_AND_BAR", "NONE"] as const) {
    const item = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: category.id,
        name: station,
        slug: `${station.toLowerCase().replaceAll("_", "-")}-${randomUUID()}`,
        price: 100,
        preparationStation: station,
      },
    });
    menuItems[station] = item.id;
  }

  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: primary.location.id,
    otherLocationId: otherLocation.location.id,
    tableId: primary.table.id,
    otherLocationTableId: otherLocation.table.id,
    otherRestaurantTableId: foreign.table.id,
    menuItems,
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("real-database waiter authorization and ownership", () => {
  it("allows a waiter to mutate their own draft and rejects another waiter", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const otherWaiter = context(fixture, "WAITER", "waiter-2");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    await expect(orders.addItem(waiter, order.id, { menuItemId: fixture.menuItems.KITCHEN, quantity: 1 })).resolves.toBeTruthy();
    await expect(orders.addItem(otherWaiter, order.id, { menuItemId: fixture.menuItems.BAR, quantity: 1 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(["OWNER", "ADMIN", "MANAGER"])("allows %s to override draft ownership", async (role) => {
    const fixture = await createFixture();
    const order = await orders.openOrder(context(fixture, "WAITER", "waiter-1"), { tableId: fixture.tableId });
    await expect(
      orders.addItem(context(fixture, role, `manager-${role}`), order.id, {
        menuItemId: fixture.menuItems.KITCHEN,
        quantity: 1,
      })
    ).resolves.toBeTruthy();
  });

  it.each(["KITCHEN", "BAR"])("rejects %s mutations", async (role) => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await expect(
      orders.addItem(context(fixture, role, role.toLowerCase()), order.id, {
        menuItemId: fixture.menuItems.KITCHEN,
        quantity: 1,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("blocks cross-location and cross-restaurant access", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await expect(orders.openOrder(waiter, { tableId: fixture.otherLocationTableId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(orders.openOrder(waiter, { tableId: fixture.otherRestaurantTableId })).rejects.toThrow("Sto nije pronađen");
  });
});

describe("real-database station routing and transaction behavior", () => {
  it("routes all station modes and advances kitchen/bar independently", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    for (const station of ["KITCHEN", "BAR", "KITCHEN_AND_BAR", "NONE"] as const) {
      await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItems[station], quantity: 1 });
    }
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: { include: { stationStates: true } }, events: true },
    });
    const byName = new Map(stored.items.map((item) => [item.name, item]));
    expect(byName.get("KITCHEN")?.stationStates.map((state) => state.station)).toEqual(["KITCHEN"]);
    expect(byName.get("BAR")?.stationStates.map((state) => state.station)).toEqual(["BAR"]);
    expect(byName.get("KITCHEN_AND_BAR")?.stationStates.map((state) => state.station).sort()).toEqual(["BAR", "KITCHEN"]);
    expect(byName.get("NONE")?.stationStates).toHaveLength(0);
    expect(byName.get("NONE")?.status).toBe("SERVED");
    expect(stored.events.some((event) => event.type === "order_submitted")).toBe(true);
    expect(await prisma.auditLog.count({ where: { entityId: order.id, action: "order.submitted" } })).toBe(1);

    const kitchen = await production.listStationOrders(context(fixture, "KITCHEN", "kitchen"), fixture.locationId, "KITCHEN");
    const bar = await production.listStationOrders(context(fixture, "BAR", "bar"), fixture.locationId, "BAR");
    expect(kitchen[0].items.map((item) => item.name).sort()).toEqual(["KITCHEN", "KITCHEN_AND_BAR"]);
    expect(bar[0].items.map((item) => item.name).sort()).toEqual(["BAR", "KITCHEN_AND_BAR"]);

    const combo = byName.get("KITCHEN_AND_BAR")!;
    await production.advanceItemStatus(context(fixture, "KITCHEN", "kitchen"), order.id, combo.id, "KITCHEN", "SUBMITTED");
    let states = await prisma.orderItemStation.findMany({ where: { orderItemId: combo.id } });
    expect(states.find((state) => state.station === "KITCHEN")?.status).toBe("ACCEPTED");
    expect(states.find((state) => state.station === "BAR")?.status).toBe("SUBMITTED");
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: combo.id } })).status).toBe("SUBMITTED");

    await production.advanceItemStatus(context(fixture, "BAR", "bar"), order.id, combo.id, "BAR", "SUBMITTED");
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: combo.id } })).status).toBe("ACCEPTED");
  });

  it("allows only one of two concurrent station advancements to commit", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItems.KITCHEN, quantity: 1 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    const kitchen = context(fixture, "KITCHEN", "kitchen");

    const results = await Promise.allSettled([
      production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "SUBMITTED"),
      production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "SUBMITTED"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.id } })).status).toBe("ACCEPTED");
    const statusEvents = await prisma.orderEvent.findMany({ where: { orderId: order.id, type: "order_item.status_changed" } });
    expect(statusEvents).toHaveLength(1);
  });
});

describe("real-database authentication safety", () => {
  it("persists email throttle state and locks on the fifth failure", async () => {
    const key = `integration-${randomUUID()}`;
    for (let attempt = 0; attempt < 5; attempt++) await recordFailedLogin(key);
    expect(await getActiveLoginThrottle(key)).toBeInstanceOf(Date);
    expect((await prisma.loginThrottle.findUniqueOrThrow({ where: { key } })).failedAttempts).toBe(5);
  });

  it("serializes concurrent PIN failures into a lockout", async () => {
    const fixture = await createFixture();
    const pinHash = await hashPin("1234");
    const employee = await prisma.employee.create({
      data: { restaurantId: fixture.restaurantId, firstName: "PIN", lastName: "User", pinHash },
    });
    const device = await prisma.device.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "POS" },
    });
    const request = () => new Request("http://localhost/api/auth/pin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeId: employee.id, deviceId: device.id, pin: "9999" }),
    });

    const responses = await Promise.all(Array.from({ length: 5 }, () => pinLogin(request())));
    expect(responses.some((response) => response.status === 423)).toBe(true);
    const updated = await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
    expect(updated.failedPinAttempts).toBe(0);
    expect(updated.pinLockedUntil && updated.pinLockedUntil > new Date()).toBe(true);
  });

  it("rejects existing sessions after user, restaurant, or tenant deactivation", async () => {
    const fixture = await createFixture();
    const user = await prisma.user.create({ data: { username: `${randomUUID()}@test.local`, isActive: true } });
    const employee = await prisma.employee.create({
      data: { restaurantId: fixture.restaurantId, userId: user.id, firstName: "Session", lastName: "User" },
    });
    const token = await createSessionToken({ userId: user.id, employeeId: employee.id, restaurantId: fixture.restaurantId });
    const request = () => new Request("http://localhost/protected", { headers: { cookie: `rcs_session=${token}` } });

    await expect(requireAuth(request())).resolves.toBeTruthy();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    await expect(requireAuth(request())).rejects.toBeInstanceOf(UnauthorizedError);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });

    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { status: "SUSPENDED" } });
    await expect(requireAuth(request())).rejects.toBeInstanceOf(UnauthorizedError);
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { status: "ACTIVE" } });

    const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: fixture.restaurantId } });
    await prisma.tenant.update({ where: { id: restaurant.tenantId }, data: { status: "SUSPENDED" } });
    await expect(requireAuth(request())).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
