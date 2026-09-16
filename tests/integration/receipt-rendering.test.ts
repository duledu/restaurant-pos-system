/**
 * RECEIPT RENDERING POLISH — restaurant name/VAT-display admin
 * configuration, permission gating, tenant isolation, and (most
 * importantly) historical-accuracy on reprint: renaming the restaurant/
 * table/employee or flipping the VAT-display toggle AFTER a receipt was
 * issued must never change what a later reprint of that SAME receipt
 * shows. See print-service.ts's dispatchReceiptPrintJob for the mechanism
 * (a reprint reuses the ORIGINAL automatic dispatch's frozen PrintJob.content
 * verbatim, never recomputes it from live settings).
 *
 * BLOCKED in this sandbox for the same reason as every other integration
 * test this session (embedded-PostgreSQL-as-Windows-Administrator
 * limitation, see tests/integration/printing-modes.test.ts and
 * print-reprint.test.ts) — never run here, never falsely reported as
 * passing. The renderer-level assertions this test would make (Serbian
 * money/date formatting, table-label duplication, drawn separators,
 * two-column layout) are instead proven directly against the real POS-58
 * driver in apps/print-agent/SelfTests.cs, which DOES run in this sandbox.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, printing, settings, tables } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  floorId: string;
  tableId: string;
  menuItemId: string;
  waiterEmployeeId: string;
}

function context(fixture: Fixture, role: string, employeeId: string, permissions: string[], restaurantId = fixture.restaurantId): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(permissions),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "ReceiptRendering tenant", slug: `receipt-rendering-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restoran A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restoran B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "Sto 1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" } });
  const menuItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Burger", slug: `burger-${randomUUID()}`, price: "1200.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const waiterUser = await prisma.user.create({ data: { username: `waiter-${randomUUID()}` } });
  const waiterEmployee = await prisma.employee.create({
    data: { restaurantId: restaurant.id, userId: waiterUser.id, firstName: "Marko", lastName: "Marković" },
  });
  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: location.id,
    floorId: floor.id,
    tableId: table.id,
    menuItemId: menuItem.id,
    waiterEmployeeId: waiterEmployee.id,
  };
}

async function payOrder(fixture: Fixture) {
  const waiter = context(fixture, "WAITER", fixture.waiterEmployeeId, ["orders.print"]);
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
  const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
  const { payment, receipt } = await billing.completePayment(waiter, submitted.id, { method: "CASH", tenderedAmount: 2000 });
  return { order: submitted, payment, receipt };
}

function ownerCtx(fixture: Fixture, restaurantId = fixture.restaurantId): AuthContext {
  return context(fixture, "OWNER", "owner-1", ["settings.manage"], restaurantId);
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("Restaurant name — Admin-editable, reused, tenant-isolated", () => {
  it("defaults to the seeded name and Admin can change it", async () => {
    const fixture = await createFixture();
    expect(await settings.getRestaurantName(fixture)).toBe("Restoran A");
    await settings.updateRestaurantName(ownerCtx(fixture), "Restoran Stari Hrast");
    expect(await settings.getRestaurantName(fixture)).toBe("Restoran Stari Hrast");
  });

  it("rejects a blank name", async () => {
    const fixture = await createFixture();
    await expect(settings.updateRestaurantName(ownerCtx(fixture), "   ")).rejects.toThrow();
  });

  it("requires settings.manage — a waiter cannot rename the restaurant", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1", ["orders.print"]);
    await expect(settings.updateRestaurantName(waiter, "Hacked Name")).rejects.toThrow(ForbiddenError);
  });

  it("is tenant-isolated — renaming Restaurant A never touches Restaurant B", async () => {
    const fixture = await createFixture();
    await settings.updateRestaurantName(ownerCtx(fixture), "Restoran A Novo Ime");
    expect(await settings.getRestaurantName({ restaurantId: fixture.otherRestaurantId })).toBe("Restoran B");
  });

  it("audits the change with before/after values", async () => {
    const fixture = await createFixture();
    await settings.updateRestaurantName(ownerCtx(fixture), "Restoran Stari Hrast");
    const entry = await prisma.auditLog.findFirst({ where: { restaurantId: fixture.restaurantId, action: "restaurant.name_updated" } });
    expect(entry).toBeTruthy();
    expect((entry!.previousValue as { name: string }).name).toBe("Restoran A");
    expect((entry!.newValue as { name: string }).name).toBe("Restoran Stari Hrast");
  });
});

describe("VAT display toggle — Admin-configurable, tenant-isolated, defaults preserve existing behavior", () => {
  it("defaults to true (every existing restaurant keeps showing the breakdown with zero admin action)", async () => {
    const fixture = await createFixture();
    expect((await settings.getRestaurantSettings(fixture)).showTaxBreakdown).toBe(true);
  });

  it("Admin can turn it off and back on", async () => {
    const fixture = await createFixture();
    await settings.updateRestaurantSettings(ownerCtx(fixture), { showTaxBreakdown: false });
    expect((await settings.getRestaurantSettings(fixture)).showTaxBreakdown).toBe(false);
    await settings.updateRestaurantSettings(ownerCtx(fixture), { showTaxBreakdown: true });
    expect((await settings.getRestaurantSettings(fixture)).showTaxBreakdown).toBe(true);
  });

  it("requires settings.manage — a waiter cannot change it", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1", ["orders.print"]);
    await expect(settings.updateRestaurantSettings(waiter, { showTaxBreakdown: false })).rejects.toThrow(ForbiddenError);
  });

  it("is tenant-isolated — Restaurant B keeps the default after Restaurant A turns it off", async () => {
    const fixture = await createFixture();
    await settings.updateRestaurantSettings(ownerCtx(fixture), { showTaxBreakdown: false });
    expect((await settings.getRestaurantSettings({ restaurantId: fixture.otherRestaurantId })).showTaxBreakdown).toBe(true);
  });

  it("is frozen into the automatic dispatch's PrintJob.content at the moment of payment", async () => {
    const fixture = await createFixture();
    await settings.updateRestaurantSettings(ownerCtx(fixture), { showTaxBreakdown: false });
    const { order } = await payOrder(fixture);
    const job = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "RECEIPT" } });
    expect((job.content as { showTaxBreakdown?: boolean }).showTaxBreakdown).toBe(false);
  });
});

describe("Historical accuracy on reprint — renaming/reconfiguring after the fact never rewrites an issued receipt", () => {
  it("U: restaurant renamed after the receipt — reprint still shows the OLD name", async () => {
    const fixture = await createFixture();
    const { order } = await payOrder(fixture);
    const originalJob = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "RECEIPT" } });

    await settings.updateRestaurantName(ownerCtx(fixture), "Restoran Novo Ime");
    const waiter = context(fixture, "WAITER", fixture.waiterEmployeeId, ["orders.print"]);
    const reprintJob = await printing.reprintReceipt(waiter, order.id, randomUUID());

    expect((reprintJob.content as { restaurantName: string }).restaurantName).toBe((originalJob.content as { restaurantName: string }).restaurantName);
    expect((reprintJob.content as { restaurantName: string }).restaurantName).toBe("Restoran A");
  });

  it("V: table renamed after the receipt — reprint still shows the OLD table label", async () => {
    const fixture = await createFixture();
    const { order } = await payOrder(fixture);
    const owner = context(fixture, "OWNER", "owner-1", ["settings.manage"]);
    await tables.updateTable(owner, fixture.tableId, { label: "Terasa 9" });

    const waiter = context(fixture, "WAITER", fixture.waiterEmployeeId, ["orders.print"]);
    const reprintJob = await printing.reprintReceipt(waiter, order.id, randomUUID());
    expect((reprintJob.content as { tableLabel: string }).tableLabel).toBe("Sto 1");
  });

  it("W: employee (waiter) renamed after the receipt — reprint still shows the OLD waiter name", async () => {
    const fixture = await createFixture();
    const { order } = await payOrder(fixture);
    await prisma.employee.update({ where: { id: fixture.waiterEmployeeId }, data: { firstName: "Petar", lastName: "Petrović" } });

    const waiter = context(fixture, "WAITER", fixture.waiterEmployeeId, ["orders.print"]);
    const reprintJob = await printing.reprintReceipt(waiter, order.id, randomUUID());
    expect((reprintJob.content as { waiterName: string }).waiterName).toBe("Marko Marković");
  });

  it("X: VAT display toggled off after the receipt — reprint still shows the breakdown that was actually shown originally", async () => {
    const fixture = await createFixture();
    const { order } = await payOrder(fixture); // showTaxBreakdown defaults true at this point
    await settings.updateRestaurantSettings(ownerCtx(fixture), { showTaxBreakdown: false });

    const waiter = context(fixture, "WAITER", fixture.waiterEmployeeId, ["orders.print"]);
    const reprintJob = await printing.reprintReceipt(waiter, order.id, randomUUID());
    expect((reprintJob.content as { showTaxBreakdown?: boolean }).showTaxBreakdown).toBe(true);
  });

  it("the reprint's content is byte-for-byte identical to the original dispatch's content, not merely equivalent field values", async () => {
    const fixture = await createFixture();
    const { order } = await payOrder(fixture);
    const originalJob = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "RECEIPT" } });

    await settings.updateRestaurantName(ownerCtx(fixture), "Restoran Novo Ime");
    await settings.updateRestaurantSettings(ownerCtx(fixture), { address: "Nova Adresa 5", showTaxBreakdown: false });

    const waiter = context(fixture, "WAITER", fixture.waiterEmployeeId, ["orders.print"]);
    const reprintJob = await printing.reprintReceipt(waiter, order.id, randomUUID());
    expect(reprintJob.content).toEqual(originalJob.content);
    expect(reprintJob.reprintOfId).toBe(originalJob.id);
  });

  it("multiple reprints after multiple setting changes all still replay the SAME original content", async () => {
    const fixture = await createFixture();
    const { order } = await payOrder(fixture);
    const originalJob = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "RECEIPT" } });
    const waiter = context(fixture, "WAITER", fixture.waiterEmployeeId, ["orders.print"]);

    await settings.updateRestaurantSettings(ownerCtx(fixture), { showTaxBreakdown: false });
    const reprint1 = await printing.reprintReceipt(waiter, order.id, randomUUID());
    await settings.updateRestaurantSettings(ownerCtx(fixture), { showTaxBreakdown: true });
    const reprint2 = await printing.reprintReceipt(waiter, order.id, randomUUID());

    expect(reprint1.content).toEqual(originalJob.content);
    expect(reprint2.content).toEqual(originalJob.content);
  });
});

describe("Multiple VAT rates flow through to the frozen receipt unchanged", () => {
  it("a receipt with items at two different tax rates freezes a taxBreakdown with two entries", async () => {
    const fixture = await createFixture();
    const lowRateItem = await prisma.menuItem.create({
      data: { restaurantId: fixture.restaurantId, categoryId: (await prisma.menuCategory.findFirstOrThrow({ where: { restaurantId: fixture.restaurantId } })).id,
        name: "Hleb", slug: `hleb-${randomUUID()}`, price: "100.00", taxRate: "10", preparationStation: "KITCHEN" },
    });
    const waiter = context(fixture, "WAITER", fixture.waiterEmployeeId, ["orders.print"]);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 }); // 20%
    await orders.addItem(waiter, order.id, { menuItemId: lowRateItem.id, quantity: 1 }); // 10%
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiter, submitted.id, { method: "CASH", tenderedAmount: 5000 });

    const job = await prisma.printJob.findFirstOrThrow({ where: { orderId: submitted.id, type: "RECEIPT" } });
    const taxBreakdown = (job.content as { taxBreakdown: { taxRate: string }[] }).taxBreakdown;
    expect(taxBreakdown).toHaveLength(2);
    expect(taxBreakdown.map((t) => t.taxRate).sort()).toEqual(["10", "20"]);
  });
});
