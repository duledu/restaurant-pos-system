import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { orders, voids, billing, shifts, reporting, audit } from "@rcs/domain";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  tableId: string;
  otherLocationTableId: string;
  menuItemId: string;
}

const MANAGEMENT_ROLES = new Set(["OWNER", "ADMIN", "MANAGER"]);

function context(fixture: Fixture, role: string, employeeId: string, locationIds: string[]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds,
    roles: [role],
    permissions: new Set(MANAGEMENT_ROLES.has(role) ? ["audit.view", "shifts.manage"] : []),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Report tenant", slug: `report-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({
    data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD", timezone: "Europe/Belgrade" },
  });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Other" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  const otherFloor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, name: "Floor 2" } });
  const otherLocationTable = await prisma.restaurantTable.create({ data: { floorId: otherFloor.id, label: "T2" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const menuItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Burger",
      slug: `burger-${randomUUID()}`,
      price: "1000.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });

  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    tableId: table.id,
    otherLocationTableId: otherLocationTable.id,
    menuItemId: menuItem.id,
  };
}

async function payOrder(
  fixture: Fixture,
  waiter: AuthContext,
  method: "CASH" | "CARD",
  tableId: string = fixture.tableId,
  quantity = 1
) {
  const order = await orders.openOrder(waiter, { tableId });
  const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity });
  const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
  const result = await billing.completePayment(waiter, submitted.id, { method });
  return { ...result, item };
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE tenants, permissions, login_throttles CASCADE`);
});

afterAll(async () => prisma.$disconnect());

describe("reporting: sales", () => {
  it("computes correct total/cash/card sales, completed order count, and average order value", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });

    await payOrder(fixture, waiter, "CASH"); // 1200 (1000 + 20% tax)
    await payOrder(fixture, waiter, "CARD"); // 1200

    const summary = await reporting.getSalesSummary(manager, { locationId: "ALL", preset: "today" });
    expect(summary.totalSales).toBe("2400");
    expect(summary.cashSales).toBe("1200");
    expect(summary.cardSales).toBe("1200");
    expect(summary.completedOrders).toBe(2);
    expect(summary.averageOrderValue).toBe("1200");
    expect(summary.cashPercent).toBe(50);
    expect(summary.cardPercent).toBe(50);
  });

  it("returns zero sales for 'yesterday' when all activity happened today", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    await payOrder(fixture, waiter, "CASH");

    const yesterday = await reporting.getSalesSummary(manager, { locationId: "ALL", preset: "yesterday" });
    expect(yesterday.totalSales).toBe("0");
    expect(yesterday.completedOrders).toBe(0);
  });

  it("scopes sales to the requested location and rejects a location the caller can't access", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    await payOrder(fixture, waiter, "CASH");

    const scoped = await reporting.getSalesSummary(manager, { locationId: fixture.locationId, preset: "today" });
    expect(scoped.totalSales).toBe("1200");

    await expect(
      reporting.getSalesSummary(manager, { locationId: fixture.otherLocationId, preset: "today" })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("aggregates sales by employee", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiterA = context(fixture, "WAITER", "waiter-a", [fixture.locationId]);
    const waiterB = context(fixture, "WAITER", "waiter-b", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    await payOrder(fixture, waiterA, "CASH");
    await payOrder(fixture, waiterB, "CARD");

    const rows = await reporting.getSalesByEmployee(manager, { locationId: "ALL", preset: "today" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sales === "1200")).toBe(true);
  });
});

describe("reporting: shifts", () => {
  it("reports an open shift with live sales and no reconciliation numbers yet", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 500 });
    await payOrder(fixture, waiter, "CASH");

    const rows = await reporting.getShiftReport(manager, { locationId: "ALL", preset: "today" });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("OPEN");
    expect(rows[0].cashSales).toBe("1200");
    expect(rows[0].expectedCash).toBeNull();
    expect(rows[0].cashDifference).toBeNull();
  });

  it("reports expected/declared cash and the discrepancy for a closed shift", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 1000 });
    await payOrder(fixture, waiter, "CASH"); // 1200 cash -> expected = 1000 + 1200 = 2200
    await shifts.closeShift(manager, shift.id, { countedCash: 2100 }); // declared 2100 -> difference -100

    const rows = await reporting.getShiftReport(manager, { locationId: "ALL", preset: "today" });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("CLOSED");
    expect(rows[0].expectedCash).toBe("2200");
    expect(rows[0].countedCash).toBe("2100");
    expect(rows[0].cashDifference).toBe("-100");
  });
});

describe("reporting: voids", () => {
  it("reports void count and value per employee", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 2 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 1,
      reasonCode: "WRONG_QUANTITY",
      explanation: "Entered 2 instead of 1 by mistake, correcting now.",
    });

    const summary = await reporting.getVoidSummaryByEmployee(manager, { locationId: "ALL", preset: "today" });
    expect(summary).toHaveLength(1);
    expect(summary[0].voidCount).toBe(1);
    expect(summary[0].voidValue).toBe("1000");

    const list = await reporting.getVoidReport(manager, { locationId: "ALL", preset: "today" });
    expect(list).toHaveLength(1);
    expect(list[0].reasonLabel).toBe("Pogrešno uneta količina");
    expect(list[0].tableLabel).toBe("T1");
  });

  it("excludes voids outside the selected date range and location", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId, fixture.otherLocationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId, fixture.otherLocationId]);
    await shifts.openShift(manager, { locationId: fixture.otherLocationId, openingCash: 0 });

    const order = await orders.openOrder(waiter, { tableId: fixture.otherLocationTableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 1,
      reasonCode: "OTHER",
      explanation: "Customer left without paying, item never served.",
    });

    const scopedToMain = await reporting.getVoidReport(manager, { locationId: fixture.locationId, preset: "today" });
    expect(scopedToMain).toHaveLength(0);
    const scopedToOther = await reporting.getVoidReport(manager, { locationId: fixture.otherLocationId, preset: "today" });
    expect(scopedToOther).toHaveLength(1);
    const yesterday = await reporting.getVoidReport(manager, { locationId: "ALL", preset: "yesterday" });
    expect(yesterday).toHaveLength(0);
  });
});

describe("reporting: suspicious activity signals", () => {
  it("surfaces a frequent-void signal once the threshold is crossed", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    const floor = await prisma.floor.findFirstOrThrow({ where: { locationId: fixture.locationId } });

    for (let i = 0; i < 5; i++) {
      const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: `V-${i}` } });
      const order = await orders.openOrder(waiter, { tableId: table.id });
      const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
      const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
      await voids.voidOrderItem(manager, submitted.id, item.id, {
        quantity: 1,
        reasonCode: "OTHER",
        explanation: "Order cancelled before service, guest left.",
      });
    }

    const signals = await audit.getSuspiciousActivity(manager, { locationId: "ALL" });
    const frequent = signals.find((s) => s.category === "FREQUENT_VOIDS");
    expect(frequent).toBeTruthy();
    expect(frequent?.count).toBe(5);
  });

  it("surfaces a high-value void signal", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 4 }); // 4000 >= 3000 threshold
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 4,
      reasonCode: "CUSTOMER_CHANGED_MIND",
      explanation: "Whole order cancelled, customer changed their mind entirely.",
    });

    const signals = await audit.getSuspiciousActivity(manager, { locationId: "ALL" });
    expect(signals.some((s) => s.category === "HIGH_VALUE_VOID")).toBe(true);
  });

  it("surfaces a cash discrepancy signal from a closed shift", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 10000 });
    await shifts.closeShift(manager, shift.id, { countedCash: 8000 }); // -2000, > WARNING threshold

    const signals = await audit.getSuspiciousActivity(manager, { locationId: "ALL" });
    const discrepancy = signals.find((s) => s.category === "CASH_DISCREPANCY");
    expect(discrepancy).toBeTruthy();
    expect(discrepancy?.value).toBe("-2000");
  });

  it("surfaces repeated rejected sensitive-operation attempts, correctly attributed for a PIN-only employee", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    // PIN-only zaposleni (bez User naloga) — ctx.userId je onda employeeId
    // po fallback konvenciji (vidi pin-login/route.ts), tačno slučaj koji je
    // ispravljen u resolveEmployeeDisplayNames.
    const pinOnlyWaiterId = "waiter-pin-only";
    await prisma.employee.create({
      data: { id: pinOnlyWaiterId, restaurantId: fixture.restaurantId, firstName: "Pin", lastName: "Waiter" },
    });
    const waiter: AuthContext = {
      userId: pinOnlyWaiterId,
      employeeId: pinOnlyWaiterId,
      restaurantId: fixture.restaurantId,
      locationIds: [fixture.locationId],
      roles: ["WAITER"],
      permissions: new Set(),
    };
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    for (let i = 0; i < 3; i++) {
      await orders.removeItem(waiter, submitted.id, item.id).catch(() => {});
    }

    const signals = await audit.getSuspiciousActivity(manager, { locationId: "ALL" });
    const rejected = signals.find((s) => s.category === "UNAUTHORIZED_ATTEMPTS");
    expect(rejected).toBeTruthy();
    expect(rejected?.employeeName).toBe("Pin Waiter"); // ne "?"
    expect(rejected?.count).toBe(3);
  });
});

describe("reporting: security boundaries", () => {
  it("rejects WAITER, KITCHEN, and BAR roles from all reporting functions", async () => {
    const fixture = await createFixture();
    for (const role of ["WAITER", "KITCHEN", "BAR"]) {
      const ctx = context(fixture, role, `emp-${role}`, [fixture.locationId]);
      await expect(reporting.getSalesSummary(ctx, { locationId: "ALL", preset: "today" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(reporting.getShiftReport(ctx, { locationId: "ALL", preset: "today" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(reporting.getVoidReport(ctx, { locationId: "ALL", preset: "today" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(audit.getSuspiciousActivity(ctx, { locationId: "ALL" })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("allows OWNER/ADMIN/MANAGER access per the permission system", async () => {
    const fixture = await createFixture();
    for (const role of ["OWNER", "ADMIN", "MANAGER"]) {
      const ctx = context(fixture, role, `mgr-${role}`, [fixture.locationId]);
      await expect(reporting.getSalesSummary(ctx, { locationId: "ALL", preset: "today" })).resolves.toBeTruthy();
    }
  });

  it("rejects cross-restaurant reporting access", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    await payOrder(fixture, waiter, "CASH"); // real sales in restaurant A

    // Zaposleni restorana B — realan session bi IMAO SAMO lokacije restorana B
    // u ctx.locationIds (requireAuth ih učitava zajedno sa restaurantId-jem;
    // "tuđa lokacija u tvom ctx-u" ne može nastati kroz stvarni login tok).
    const otherLocation = await prisma.location.create({ data: { restaurantId: fixture.otherRestaurantId, name: "B Location" } });
    const outsider = context(fixture, "MANAGER", "outsider", [otherLocation.id]);
    outsider.restaurantId = fixture.otherRestaurantId;

    // Pokušaj da se pročita restoran-A lokacija: odbijeno jer nije u
    // outsider-ovom ctx.locationIds.
    await expect(reporting.getSalesSummary(outsider, { locationId: fixture.locationId, preset: "today" })).rejects.toBeInstanceOf(
      ForbiddenError
    );

    // Odbrana u dubinu: ČAK I kad bi neko (bug u budućnosti) zaobišao
    // requireLocationAccess i pozvao servis sa "ALL", upit je i dalje
    // filtriran po ctx.restaurantId u WHERE klauzuli — restoran A-ova
    // prodaja se NIKAD ne pojavljuje u odgovoru za restoran B.
    const allForOutsider = await reporting.getSalesSummary(outsider, { locationId: "ALL", preset: "today" });
    expect(allForOutsider.totalSales).toBe("0");
  });

  it("rejects cross-location reporting access even for an otherwise-authorized manager", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]); // NEMA pristup otherLocationId
    await expect(
      reporting.getSalesSummary(manager, { locationId: fixture.otherLocationId, preset: "today" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reporting.getCurrentStatus(manager, { locationId: fixture.otherLocationId })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("'ALL' locations only scopes to the caller's own accessible locations, never the whole restaurant", async () => {
    const fixture = await createFixture();
    const managerBothLocations = context(fixture, "MANAGER", "mgr-both", [fixture.locationId, fixture.otherLocationId]);
    const managerOneLocation = context(fixture, "MANAGER", "mgr-one", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId, fixture.otherLocationId]);

    await shifts.openShift(managerBothLocations, { locationId: fixture.otherLocationId, openingCash: 0 });
    await payOrder(fixture, waiter, "CASH", fixture.otherLocationTableId);

    const allForRestrictedManager = await reporting.getSalesSummary(managerOneLocation, { locationId: "ALL", preset: "today" });
    expect(allForRestrictedManager.totalSales).toBe("0"); // ne vidi prodaju sa lokacije kojoj nema pristup

    const allForFullManager = await reporting.getSalesSummary(managerBothLocations, { locationId: "ALL", preset: "today" });
    expect(allForFullManager.totalSales).toBe("1200");
  });
});

describe("reporting: historical integrity", () => {
  it("keeps historical sales correct after the menu item price and name later change", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });
    await payOrder(fixture, waiter, "CARD"); // 1200 at the ORIGINAL price

    await prisma.menuItem.update({ where: { id: fixture.menuItemId }, data: { price: "9999.00", name: "Renamed Item" } });

    const summary = await reporting.getSalesSummary(manager, { locationId: "ALL", preset: "today" });
    expect(summary.totalSales).toBe("1200"); // nepromenjeno
  });

  it("keeps historical void value correct after the menu item price later changes", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1", [fixture.locationId]);
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId]);
    await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 0 });

    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await prisma.menuItem.update({ where: { id: fixture.menuItemId }, data: { price: "50000.00" } });

    await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 1,
      reasonCode: "OTHER",
      explanation: "Kitchen ran out of ingredients for this dish today.",
    });

    const summary = await reporting.getVoidSummaryByEmployee(manager, { locationId: "ALL", preset: "today" });
    expect(summary[0].voidValue).toBe("1000"); // originalna cena, ne 50000
  });
});
