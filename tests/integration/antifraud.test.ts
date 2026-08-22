/**
 * P2.2 — Lightweight Anti-Fraud Dashboard integration tests.
 *
 * Covers: excessive voids, normal void (no false positive), void after
 * production, cash discrepancy (and exact-match non-signal), inventory
 * adjustment/write-off vs SALE, employee aggregation + zero-denominator
 * safety, location isolation, RBAC, financial integrity (voids not counted
 * as revenue), and order-number exposure on void events.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, voids, shifts, inventory, antifraud, reporting } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  otherLocationId: string;
  floorId: string;
  tableId: string;
  kitchenItemId: string;
  barItemId: string;
}

function managerCtx(fixture: Fixture, employeeId = "mgr-1", locationIds = [fixture.locationId]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds,
    roles: ["MANAGER"],
    permissions: new Set(["audit.view", "shifts.manage", "inventory.view", "inventory.manage", "orders.print"]),
  };
}

function roleCtx(fixture: Fixture, role: "WAITER" | "KITCHEN" | "BAR", employeeId: string): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(["menu.view"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Antifraud tenant", slug: `af-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD", timezone: "Europe/Belgrade" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Other" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  const otherFloor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, name: "Floor B" } });
  await prisma.restaurantTable.create({ data: { floorId: otherFloor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "mgr-1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, openedBy: "mgr-1" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" } });
  const kitchenItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, price: "800.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const barItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Coca-Cola", slug: `cola-${randomUUID()}`, price: "250.00", taxRate: "20", preparationStation: "BAR" },
  });
  return { restaurantId: restaurant.id, locationId: location.id, otherLocationId: otherLocation.id, floorId: floor.id, tableId: table.id, kitchenItemId: kitchenItem.id, barItemId: barItem.id };
}

async function openOrderItem(fixture: Fixture, manager: AuthContext, menuItemId: string, quantity = 1) {
  const order = await orders.openOrder(manager, { tableId: fixture.tableId });
  const item = await orders.addItem(manager, order.id, { menuItemId, quantity });
  const submitted = await orders.submitOrder(manager, order.id, { idempotencyKey: randomUUID() });
  return { order: submitted, item };
}

async function serve(itemId: string, station: "KITCHEN" | "BAR") {
  await prisma.orderItemStation.update({
    where: { orderItemId_station: { orderItemId: itemId, station } },
    data: { status: "SERVED" },
  });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("excessive voids", () => {
  it("surfaces an employee with repeated voids as FREQUENT_VOIDS, and reflects it in the employee summary", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    for (let i = 0; i < 6; i++) {
      // Sveži sto po iteraciji — voidOrderItem ne menja Order.status, pa bi
      // ponovno korišćenje istog stola vratilo ISTU (već aktivnu) porudžbinu
      // umesto da otvori novu (vidi openOrder: "existingActive" pretraga).
      const freshTable = await prisma.restaurantTable.create({ data: { floorId: fixture.floorId, label: `V${i}` } });
      const { order, item } = await openOrderItem({ ...fixture, tableId: freshTable.id }, manager, fixture.kitchenItemId, 1);
      await voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: "Gost je promenio mišljenje pre nego što je bilo šta pripremljeno." });
    }

    const filters = { locationId: "ALL", preset: "today" } as const;
    const signals = await antifraud.getSignals(manager, filters);
    const frequentVoids = signals.find((s) => s.category === "FREQUENT_VOIDS" && s.employeeId === "mgr-1");
    expect(frequentVoids).toBeDefined();
    expect(frequentVoids?.count).toBe(6);

    const employeeRows = await antifraud.getEmployeeAntiFraudSummary(manager, filters);
    const row = employeeRows.find((r) => r.employeeId === "mgr-1");
    expect(row?.voidCount).toBe(6);
    expect(row?.signalsCount).toBeGreaterThan(0);
  });
});

describe("normal void does not create a false positive", () => {
  it("a single small void, not yet served, produces no FREQUENT_VOIDS/HIGH_VALUE_VOID/VOID_AFTER_PRODUCTION signal", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const { order, item } = await openOrderItem(fixture, manager, fixture.barItemId, 1); // 250 RSD, low value
    await voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: "Gost je odustao od pića pre nego što je poslužen." });

    const filters = { locationId: "ALL", preset: "today" } as const;
    const signals = await antifraud.getSignals(manager, filters);
    expect(signals.find((s) => s.category === "FREQUENT_VOIDS")).toBeUndefined();
    expect(signals.find((s) => s.category === "HIGH_VALUE_VOID")).toBeUndefined();
    expect(signals.find((s) => s.category === "VOID_AFTER_PRODUCTION")).toBeUndefined();

    const voidRows = await antifraud.getVoidEvents(manager, filters);
    expect(voidRows).toHaveLength(1);
    expect(voidRows[0].producedBeforeVoid).toBe(false);
  });
});

describe("void after production", () => {
  it("flags a fully-voided item that was already SERVED before the void, and getVoidEvents marks producedBeforeVoid", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const { order, item } = await openOrderItem(fixture, manager, fixture.kitchenItemId, 1); // 800 RSD
    await serve(item.id, "KITCHEN");
    await voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: "Gost je otkazao posle što je jelo već bilo gotovo." });

    const filters = { locationId: "ALL", preset: "today" } as const;
    const signals = await antifraud.getSignals(manager, filters);
    const signal = signals.find((s) => s.category === "VOID_AFTER_PRODUCTION");
    expect(signal).toBeDefined();
    expect(signal?.employeeId).toBe("mgr-1");

    const voidRows = await antifraud.getVoidEvents(manager, filters);
    expect(voidRows).toHaveLength(1);
    expect(voidRows[0].producedBeforeVoid).toBe(true);
    expect(voidRows[0].isFullVoid).toBe(true);
  });

  it("does NOT flag a partial void where the item is still active (not proven prepared before the void)", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const { order, item } = await openOrderItem(fixture, manager, fixture.kitchenItemId, 3);
    await voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: "Gost je smanjio količinu pre pripreme." });

    const voidRows = await antifraud.getVoidEvents(manager, { locationId: "ALL", preset: "today" });
    expect(voidRows[0].isFullVoid).toBe(false);
    expect(voidRows[0].producedBeforeVoid).toBe(false);
  });
});

describe("cash discrepancy", () => {
  it("surfaces a closed shift with a meaningful cash difference, and getAntiFraudOverview counts it", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 5000 });
    await shifts.closeShift(manager, shift.id, { countedCash: 5000 - 1500 }); // manjak 1500

    const filters = { locationId: "ALL", preset: "today" } as const;
    const cashRows = await antifraud.getCashDiscrepancyEvents(manager, filters);
    expect(cashRows).toHaveLength(1);
    expect(cashRows[0].kind).toBe("shortage");
    expect(Number(cashRows[0].cashDifference)).toBeCloseTo(-1500, 2);

    const signals = await antifraud.getSignals(manager, filters);
    expect(signals.find((s) => s.category === "CASH_DISCREPANCY")).toBeDefined();

    const overview = await antifraud.getAntiFraudOverview(manager, filters);
    expect(overview.cashDiscrepancyShiftsCount).toBe(1);
    expect(Number(overview.cashDiscrepancyAbsTotal)).toBeCloseTo(1500, 2);
  });

  it("detects an overage (višak) as well, not only a shortage", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 5000 });
    await shifts.closeShift(manager, shift.id, { countedCash: 5000 + 3000 }); // višak 3000

    const cashRows = await antifraud.getCashDiscrepancyEvents(manager, { locationId: "ALL", preset: "today" });
    expect(cashRows).toHaveLength(1);
    expect(cashRows[0].kind).toBe("overage");
  });

  it("an exactly-matching shift close produces no cash discrepancy row or signal", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const shift = await shifts.openShift(manager, { locationId: fixture.locationId, openingCash: 5000 });
    await shifts.closeShift(manager, shift.id, { countedCash: 5000 });

    const filters = { locationId: "ALL", preset: "today" } as const;
    const cashRows = await antifraud.getCashDiscrepancyEvents(manager, filters);
    expect(cashRows).toHaveLength(0);
    const signals = await antifraud.getSignals(manager, filters);
    expect(signals.find((s) => s.category === "CASH_DISCREPANCY")).toBeUndefined();
  });
});

describe("inventory adjustments and write-offs", () => {
  it("a manual negative adjustment appears in getInventoryAdjustmentEvents", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const invItem = await inventory.initializeTracking(manager, { menuItemId: fixture.kitchenItemId, locationId: fixture.locationId, initialStock: 20 });
    await inventory.adjustStock(manager, invItem.id, { delta: -5, reason: "Inventura — manjak na polici" });

    const rows = await antifraud.getInventoryAdjustmentEvents(manager, { locationId: "ALL", preset: "today" });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("ADJUSTMENT");
    expect(Number(rows[0].quantityDelta)).toBe(-5);
  });

  it("a large write-off is flagged as LARGE_INVENTORY_WRITE_OFF", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const invItem = await inventory.initializeTracking(manager, { menuItemId: fixture.kitchenItemId, locationId: fixture.locationId, initialStock: 50 });
    await inventory.writeOffStock(manager, invItem.id, { quantity: 15, reason: "Isteklo" });

    const signals = await antifraud.getSignals(manager, { locationId: "ALL", preset: "today" });
    expect(signals.find((s) => s.category === "LARGE_INVENTORY_WRITE_OFF")).toBeDefined();
  });

  it("a normal SALE inventory movement does NOT appear as a manual adjustment/write-off anomaly", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await inventory.initializeTracking(manager, { menuItemId: fixture.kitchenItemId, locationId: fixture.locationId, initialStock: 20 });
    const { order } = await openOrderItem(fixture, manager, fixture.kitchenItemId, 1);
    await billing.completePayment(manager, order.id, { method: "CARD" });

    const saleMovements = await prisma.inventoryMovement.findMany({ where: { restaurantId: fixture.restaurantId, type: "SALE" } });
    expect(saleMovements.length).toBeGreaterThan(0); // sanity: prodaja stvarno umanjuje zalihu

    const rows = await antifraud.getInventoryAdjustmentEvents(manager, { locationId: "ALL", preset: "today" });
    expect(rows).toHaveLength(0);
  });
});

describe("employee aggregation and zero-denominator safety", () => {
  it("computes void rate correctly, and never NaN/Infinity for an employee with zero paid checks", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    // Zaposleni ima storno ali NIJEDNU naplaćenu porudžbinu u periodu —
    // imenilac (paidChecks) je namerno 0, da se proveri da stopa ne postane NaN/Infinity.
    const { order, item } = await openOrderItem(fixture, manager, fixture.barItemId, 1);
    await voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: "Gost je otišao bez plaćanja." });

    const rows = await antifraud.getEmployeeAntiFraudSummary(manager, { locationId: "ALL", preset: "today" });
    const row = rows.find((r) => r.employeeId === "mgr-1");
    expect(row).toBeDefined();
    expect(row?.paidChecks).toBe(0);
    expect(row?.voidCount).toBe(1);
    expect(row?.voidRateByChecks).toBeNull();
    expect(row?.voidRateByValue === null || Number.isFinite(row?.voidRateByValue as number)).toBe(true);
  });

  it("computes a correct void rate when both counts are non-zero", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const { order: paidOrder } = await openOrderItem(fixture, manager, fixture.kitchenItemId, 1);
    await billing.completePayment(manager, paidOrder.id, { method: "CASH" });
    const { order: voidedOrder, item } = await openOrderItem(fixture, manager, fixture.barItemId, 1);
    await voids.voidOrderItem(manager, voidedOrder.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: "Gost je odustao od pića." });

    const rows = await antifraud.getEmployeeAntiFraudSummary(manager, { locationId: "ALL", preset: "today" });
    const row = rows.find((r) => r.employeeId === "mgr-1");
    expect(row?.paidChecks).toBe(1);
    expect(row?.voidCount).toBe(1);
    expect(row?.voidRateByChecks).toBe(1); // 1 storno / 1 naplaćen ček
  });
});

describe("location isolation", () => {
  it("a manager scoped to Location A cannot retrieve Location B's anomaly data", async () => {
    const fixture = await createFixture();
    const managerA = managerCtx(fixture, "mgr-a", [fixture.locationId]);
    const managerB = managerCtx(fixture, "mgr-b", [fixture.otherLocationId]);

    // Storno u Lokaciji A.
    const { order, item } = await openOrderItem(fixture, managerA, fixture.kitchenItemId, 1);
    await voids.voidOrderItem(managerA, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: "Test izolacije lokacija — poništena stavka u Lokaciji A." });

    const filters = { locationId: "ALL", preset: "today" } as const;
    const voidRowsB = await antifraud.getVoidEvents(managerB, filters);
    expect(voidRowsB).toHaveLength(0);
    const signalsB = await antifraud.getSignals(managerB, filters);
    expect(signalsB.find((s) => s.employeeId === "mgr-a")).toBeUndefined();

    // managerB ne sme ni eksplicitno da traži Lokaciju A.
    await expect(antifraud.getVoidEvents(managerB, { locationId: fixture.locationId, preset: "today" })).rejects.toThrow();
  });
});

describe("RBAC", () => {
  it("WAITER cannot access the anti-fraud dashboard", async () => {
    const fixture = await createFixture();
    const waiter = roleCtx(fixture, "WAITER", "waiter-1");
    const filters = { locationId: "ALL", preset: "today" } as const;
    await expect(antifraud.getAntiFraudOverview(waiter, filters)).rejects.toThrow();
    await expect(antifraud.getSignals(waiter, filters)).rejects.toThrow();
    await expect(antifraud.getEmployeeAntiFraudSummary(waiter, filters)).rejects.toThrow();
  });

  it("KITCHEN and BAR cannot access the anti-fraud dashboard", async () => {
    const fixture = await createFixture();
    const kitchen = roleCtx(fixture, "KITCHEN", "kds-1");
    const bar = roleCtx(fixture, "BAR", "bar-1");
    const filters = { locationId: "ALL", preset: "today" } as const;
    await expect(antifraud.getAntiFraudOverview(kitchen, filters)).rejects.toThrow();
    await expect(antifraud.getAntiFraudOverview(bar, filters)).rejects.toThrow();
  });

  it("MANAGER (audit.view) can access the dashboard", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await expect(antifraud.getAntiFraudOverview(manager, { locationId: "ALL", preset: "today" })).resolves.toBeDefined();
  });
});

describe("financial integrity: voids are not counted as paid revenue", () => {
  it("a fully-voided item's value is excluded from getSalesSummary.totalSales for the same period", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(manager, { tableId: fixture.tableId });
    const keptItem = await orders.addItem(manager, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 }); // 960 sa porezom
    const voidedItem = await orders.addItem(manager, order.id, { menuItemId: fixture.barItemId, quantity: 1 }); // 300 sa porezom
    const submitted = await orders.submitOrder(manager, order.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(manager, submitted.id, voidedItem.id, { quantity: 1, reasonCode: "OTHER", explanation: "Gost nije naručio piće, greška konobara." });
    await billing.completePayment(manager, submitted.id, { method: "CASH" });

    const filters = { locationId: "ALL", preset: "today" } as const;
    const [overview, salesSummary] = await Promise.all([
      antifraud.getAntiFraudOverview(manager, filters),
      reporting.getSalesSummary(manager, filters),
    ]);

    expect(Number(overview.voidValue)).toBeCloseTo(250, 2); // OrderItemVoid.voidedValue je pre-poreski iznos (cena x kolicina)
    expect(Number(salesSummary.totalSales)).toBeCloseTo(960, 2); // SAMO zadržana stavka, storno nije uračunat
    void keptItem;
  });
});

describe("order number on void events", () => {
  it("exposes the human-readable receipt number once the order is paid, not the raw order UUID", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(manager, { tableId: fixture.tableId });
    const keptItem = await orders.addItem(manager, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
    const voidedItem = await orders.addItem(manager, order.id, { menuItemId: fixture.barItemId, quantity: 1 });
    const submitted = await orders.submitOrder(manager, order.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(manager, submitted.id, voidedItem.id, { quantity: 1, reasonCode: "OTHER", explanation: "Gost je odustao od pića pre naplate." });
    await billing.completePayment(manager, submitted.id, { method: "CARD" });

    const rows = await antifraud.getVoidEvents(manager, { locationId: "ALL", preset: "today" });
    expect(rows).toHaveLength(1);
    expect(rows[0].receiptNumber).not.toBeNull();
    expect(typeof rows[0].receiptNumber).toBe("number");
    void keptItem;
  });

  it("leaves receiptNumber null (not fabricated) when the order was never paid", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    const { order, item } = await openOrderItem(fixture, manager, fixture.barItemId, 1);
    await voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: "Gost je otišao bez plaćanja, sto ostaje otkazan." });

    const rows = await antifraud.getVoidEvents(manager, { locationId: "ALL", preset: "today" });
    expect(rows[0].receiptNumber).toBeNull();
    expect(rows[0].tableLabel).toBe("T1"); // ljudski čitljiva referenca postoji i bez broja računa
  });
});
