/**
 * FAZA 12 — Kuhinja/Bar izveštaj PO ZAPOSLENOM (ko je prihvatio/označio
 * spremnim, po stanici, u periodu). Izvor je POSTOJEĆI OrderEvent audit
 * trag (order_item.status_changed) — bez nove kolone/migracije. Dostupan
 * i Menadžeru/Adminu (kroz postojeći Kuhinja/Bar Admin izveštaj, prošireno
 * `employees` polje) i SAMOJ Kuhinji/Šanku (nova, uže autorizovana
 * reporting.getKitchenEmployeeReport/getBarEmployeeReport, ista
 * production.view + assertStationAccess autorizacija kao sam KDS ekran).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { orders, production, reporting } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  biftekId: string; // KITCHEN
  pomfritId: string; // KITCHEN
  colaId: string; // BAR
}

function context(
  fixture: Pick<Fixture, "restaurantId" | "locationId">,
  role: string,
  employeeId: string,
  permissions = new Set<string>()
): AuthContext {
  return { userId: employeeId, employeeId, restaurantId: fixture.restaurantId, locationIds: [fixture.locationId], roles: [role], permissions };
}

function managerCtx(fixture: Fixture, employeeId = "mgr-1"): AuthContext {
  return context(fixture, "MANAGER", employeeId, new Set(["production.view", "production.manage", "audit.view"]));
}
function kitchenCtx(fixture: Fixture, employeeId: string): AuthContext {
  return context(fixture, "KITCHEN", employeeId, new Set(["production.view", "production.manage"]));
}
function barCtx(fixture: Fixture, employeeId: string): AuthContext {
  return context(fixture, "BAR", employeeId, new Set(["production.view", "production.manage"]));
}
function waiterCtx(fixture: Fixture, employeeId = "waiter-1"): AuthContext {
  return context(fixture, "WAITER", employeeId, new Set(["menu.view", "orders.create", "orders.submit"]));
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "KB-employee-report tenant", slug: `kb-emp-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T4" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const biftek = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Biftek", slug: `biftek-${randomUUID()}`, price: "1500.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const pomfrit = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pomfrit", slug: `pomfrit-${randomUUID()}`, price: "350.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const cola = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Coca-Cola", slug: `cola-${randomUUID()}`, price: "300.00", taxRate: "20", preparationStation: "BAR" },
  });

  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, biftekId: biftek.id, pomfritId: pomfrit.id, colaId: cola.id };
}

async function submitOne(fixture: Fixture, waiter: AuthContext, menuItemId: string, quantity = 1) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  const item = await orders.addItem(waiter, order.id, { menuItemId, quantity });
  await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
  return { orderId: order.id, itemId: item.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("Kitchen/Bar employee report: per-employee attribution from the existing OrderEvent audit trail", () => {
  it("two different Kitchen employees are reported separately, with correct accepted/ready counts", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const marko = kitchenCtx(fixture, "marko-1");
    const nikola = kitchenCtx(fixture, "nikola-1");

    const a = await submitOne(fixture, waiter, fixture.biftekId);
    await production.advanceItemStatus(marko, a.orderId, a.itemId, "KITCHEN", "SUBMITTED"); // Marko: PRIHVATI
    await production.advanceItemStatus(marko, a.orderId, a.itemId, "KITCHEN", "ACCEPTED"); // Marko: SPREMNO

    const b = await submitOne(fixture, waiter, fixture.pomfritId);
    await production.advanceItemStatus(nikola, b.orderId, b.itemId, "KITCHEN", "SUBMITTED"); // Nikola: PRIHVATI only

    const manager = managerCtx(fixture);
    const report = await reporting.getKitchenEmployeeReport(manager, { locationId: "ALL", preset: "today" });

    const markoRow = report.employees.find((e) => e.employeeId === "marko-1");
    const nikolaRow = report.employees.find((e) => e.employeeId === "nikola-1");
    expect(markoRow).toMatchObject({ acceptedCount: 1, readyCount: 1 });
    expect(nikolaRow).toMatchObject({ acceptedCount: 1, readyCount: 0 });
    expect(report.employeeTotals).toEqual({ acceptedCount: 2, readyCount: 1 });
  });

  it("Bar employee activity is tracked independently — never mixed into the Kitchen report", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const marko = kitchenCtx(fixture, "marko-1");
    const jovan = barCtx(fixture, "jovan-1");

    const kitchenItem = await submitOne(fixture, waiter, fixture.biftekId);
    await production.advanceItemStatus(marko, kitchenItem.orderId, kitchenItem.itemId, "KITCHEN", "SUBMITTED");

    const barItem = await submitOne(fixture, waiter, fixture.colaId);
    await production.advanceItemStatus(jovan, barItem.orderId, barItem.itemId, "BAR", "SUBMITTED");
    await production.advanceItemStatus(jovan, barItem.orderId, barItem.itemId, "BAR", "ACCEPTED");

    const manager = managerCtx(fixture);
    const [kitchenReport, barReport] = await Promise.all([
      reporting.getKitchenEmployeeReport(manager, { locationId: "ALL", preset: "today" }),
      reporting.getBarEmployeeReport(manager, { locationId: "ALL", preset: "today" }),
    ]);

    expect(kitchenReport.employees.find((e) => e.employeeId === "jovan-1")).toBeUndefined();
    expect(kitchenReport.employees.find((e) => e.employeeId === "marko-1")).toMatchObject({ acceptedCount: 1, readyCount: 0 });
    expect(barReport.employees.find((e) => e.employeeId === "marko-1")).toBeUndefined();
    expect(barReport.employees.find((e) => e.employeeId === "jovan-1")).toMatchObject({ acceptedCount: 1, readyCount: 1 });
  });

  it("the admin Kitchen/Bar production report (Manager/Admin/Owner) now also includes the same employees breakdown", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const marko = kitchenCtx(fixture, "marko-1");
    const item = await submitOne(fixture, waiter, fixture.biftekId);
    await production.advanceItemStatus(marko, item.orderId, item.itemId, "KITCHEN", "SUBMITTED");

    const manager = managerCtx(fixture);
    const adminReport = await reporting.getKitchenProductionReport(manager, { locationId: "ALL", preset: "today" });
    expect(adminReport.employees.find((e) => e.employeeId === "marko-1")).toMatchObject({ acceptedCount: 1, readyCount: 0 });
    expect(adminReport.employeeTotals).toEqual({ acceptedCount: 1, readyCount: 0 });
  });

  it("additional-order round: a second employee's later SPREMNO is attributed to THEM, not merged with the first round's employee", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const marko = kitchenCtx(fixture, "marko-1");
    const nikola = kitchenCtx(fixture, "nikola-1");

    // Round 1: Marko does the full Omlet-equivalent (Biftek) cycle.
    const round1 = await submitOne(fixture, waiter, fixture.biftekId);
    await production.advanceItemStatus(marko, round1.orderId, round1.itemId, "KITCHEN", "SUBMITTED");
    await production.advanceItemStatus(marko, round1.orderId, round1.itemId, "KITCHEN", "ACCEPTED");

    // Round 2 (additional order, same table/order): Nikola handles the new item.
    const round2Item = await orders.addItem(waiter, round1.orderId, { menuItemId: fixture.pomfritId, quantity: 1 });
    await orders.submitOrder(waiter, round1.orderId, { idempotencyKey: randomUUID() });
    await production.advanceItemStatus(nikola, round1.orderId, round2Item.id, "KITCHEN", "SUBMITTED");
    await production.advanceItemStatus(nikola, round1.orderId, round2Item.id, "KITCHEN", "ACCEPTED");

    const manager = managerCtx(fixture);
    const report = await reporting.getKitchenEmployeeReport(manager, { locationId: "ALL", preset: "today" });
    expect(report.employees.find((e) => e.employeeId === "marko-1")).toMatchObject({ acceptedCount: 1, readyCount: 1 });
    expect(report.employees.find((e) => e.employeeId === "nikola-1")).toMatchObject({ acceptedCount: 1, readyCount: 1 });
  });

  it("waiter pickup (PREUZETO) is never counted as Kitchen/Bar accepted/ready activity", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const marko = kitchenCtx(fixture, "marko-1");
    const item = await submitOne(fixture, waiter, fixture.biftekId);
    await production.advanceItemStatus(marko, item.orderId, item.itemId, "KITCHEN", "SUBMITTED");
    await production.advanceItemStatus(marko, item.orderId, item.itemId, "KITCHEN", "ACCEPTED");
    await production.confirmPickup(waiter, item.orderId, item.itemId);

    const manager = managerCtx(fixture);
    const report = await reporting.getKitchenEmployeeReport(manager, { locationId: "ALL", preset: "today" });
    // Only Marko's ACCEPTED+READY — the waiter's pickup must not appear as a Kitchen row.
    expect(report.employees).toHaveLength(1);
    expect(report.employees[0]).toMatchObject({ employeeId: "marko-1", acceptedCount: 1, readyCount: 1 });
  });

  it("RBAC: a KITCHEN employee can read the Kitchen employee report but is rejected from the Bar one", async () => {
    const fixture = await createFixture();
    const marko = kitchenCtx(fixture, "marko-1");
    await expect(reporting.getKitchenEmployeeReport(marko, { locationId: "ALL", preset: "today" })).resolves.toBeDefined();
    await expect(reporting.getBarEmployeeReport(marko, { locationId: "ALL", preset: "today" })).rejects.toThrow(ForbiddenError);
  });

  it("RBAC: a BAR employee can read the Bar employee report but is rejected from the Kitchen one", async () => {
    const fixture = await createFixture();
    const jovan = barCtx(fixture, "jovan-1");
    await expect(reporting.getBarEmployeeReport(jovan, { locationId: "ALL", preset: "today" })).resolves.toBeDefined();
    await expect(reporting.getKitchenEmployeeReport(jovan, { locationId: "ALL", preset: "today" })).rejects.toThrow(ForbiddenError);
  });

  it("RBAC: a caller without production.view is rejected entirely", async () => {
    const fixture = await createFixture();
    const outsider = context(fixture, "KITCHEN", "kitchen-no-perm", new Set());
    await expect(reporting.getKitchenEmployeeReport(outsider, { locationId: "ALL", preset: "today" })).rejects.toThrow();
  });

  it("Manager/Admin/Owner can read both station employee reports (oversight)", async () => {
    const fixture = await createFixture();
    const manager = managerCtx(fixture);
    await expect(reporting.getKitchenEmployeeReport(manager, { locationId: "ALL", preset: "today" })).resolves.toBeDefined();
    await expect(reporting.getBarEmployeeReport(manager, { locationId: "ALL", preset: "today" })).resolves.toBeDefined();
  });

  it("is read-only — generating the report never changes order/item/station state", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const marko = kitchenCtx(fixture, "marko-1");
    const item = await submitOne(fixture, waiter, fixture.biftekId);
    await production.advanceItemStatus(marko, item.orderId, item.itemId, "KITCHEN", "SUBMITTED");

    const before = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.itemId, station: "KITCHEN" } });
    const manager = managerCtx(fixture);
    await reporting.getKitchenEmployeeReport(manager, { locationId: "ALL", preset: "today" });
    await reporting.getKitchenEmployeeReport(manager, { locationId: "ALL", preset: "today" });
    const after = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.itemId, station: "KITCHEN" } });

    expect(after.status).toBe(before.status);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});
