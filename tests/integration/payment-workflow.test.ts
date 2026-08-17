import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, billing } from "@rcs/domain";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  tableId: string;
  menuItemId: string;
  expensiveMenuItemId: string;
}

function context(fixture: Fixture, role: string, employeeId: string, locationIds = [fixture.locationId]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds,
    roles: [role],
    permissions: new Set<string>(),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Billing tenant", slug: `billing-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });

  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const menuItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Burger",
      slug: `burger-${randomUUID()}`,
      price: "100.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });
  const expensiveMenuItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Steak",
      slug: `steak-${randomUUID()}`,
      price: "500.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });

  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: location.id,
    tableId: table.id,
    menuItemId: menuItem.id,
    expensiveMenuItemId: expensiveMenuItem.id,
  };
}

async function openAndSubmitOrder(fixture: Fixture, waiter: AuthContext, menuItemId: string, quantity = 1) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  await orders.addItem(waiter, order.id, { menuItemId, quantity });
  return orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE tenants, permissions, login_throttles CASCADE`);
});

afterAll(async () => prisma.$disconnect());

describe("billing: totals and bill preview", () => {
  it("computes authoritative totals from server-side item snapshots, not client input", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 2);

    const bill = await billing.getBillPreview(waiter, submitted.id);
    expect(bill.subtotal).toBe("200");
    expect(bill.tax).toBe("40");
    expect(bill.total).toBe("240");
  });

  it("excludes CANCELLED items from the bill", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.expensiveMenuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await prisma.orderItem.update({ where: { id: item.id }, data: { status: "CANCELLED" } });

    const bill = await billing.getBillPreview(waiter, submitted.id);
    expect(bill.total).toBe("600"); // only the 500 steak line + 20% tax
  });
});

describe("billing: payment integrity", () => {
  it("completes a CASH payment, computes change, releases the table, and freezes a receipt snapshot", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 1);

    const { order, payment, receipt } = await billing.completePayment(waiter, submitted.id, {
      method: "CASH",
      tenderedAmount: 150,
    });

    expect(order.status).toBe("COMPLETED");
    expect(payment.method).toBe("CASH");
    expect(payment.amount.toString()).toBe("120");
    expect(payment.tenderedAmount.toString()).toBe("150");
    expect(payment.changeAmount.toString()).toBe("30");
    expect(receipt.total.toString()).toBe("120");
    expect(receipt.tableLabel).toBe("T1");

    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("FREE");
  });

  it("completes a CARD payment with no tendered/change amount", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 1);

    const { payment } = await billing.completePayment(waiter, submitted.id, { method: "CARD" });
    expect(payment.method).toBe("CARD");
    expect(payment.tenderedAmount.toString()).toBe("120");
    expect(payment.changeAmount.toString()).toBe("0");
  });

  it("rejects cash tendered less than the total", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 1);

    await expect(
      billing.completePayment(waiter, submitted.id, { method: "CASH", tenderedAmount: 50 })
    ).rejects.toThrow("Primljena gotovina");
  });

  it("prevents paying an order twice", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 1);

    await billing.completePayment(waiter, submitted.id, { method: "CARD" });
    await expect(billing.completePayment(waiter, submitted.id, { method: "CARD" })).rejects.toThrow("već naplaćena");
  });

  it("allows only one of two concurrent payment attempts on the same order to commit", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 1);

    const results = await Promise.allSettled([
      billing.completePayment(waiter, submitted.id, { method: "CARD" }),
      billing.completePayment(waiter, submitted.id, { method: "CASH" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await prisma.payment.count({ where: { orderId: submitted.id } })).toBe(1);
  });

  it("rejects payment on a DRAFT order", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    await expect(billing.completePayment(waiter, order.id, { method: "CARD" })).rejects.toThrow(
      "nema šta da se naplati"
    );
  });

  it("rejects payment from an employee without location access", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 1);

    const outsider = context(fixture, "WAITER", "waiter-2", []);
    await expect(billing.completePayment(outsider, submitted.id, { method: "CARD" })).rejects.toThrow();
  });

  it("keeps the receipt snapshot correct even after the menu price later changes", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 1);
    const { receipt } = await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    await prisma.menuItem.update({ where: { id: fixture.menuItemId }, data: { price: "999.00" } });

    const reloaded = await billing.getReceipt(waiter, submitted.id);
    expect(reloaded.id).toBe(receipt.id);
    expect(reloaded.total.toString()).toBe("120");
  });

  it("does not leak receipts across restaurants", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 1);
    await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    const outsiderCtx = context(fixture, "OWNER", "owner-b", []);
    outsiderCtx.restaurantId = fixture.otherRestaurantId;
    await expect(billing.getReceipt(outsiderCtx, submitted.id)).rejects.toThrow("nije pronađen");
  });
});

describe("billing: table lifecycle", () => {
  it("re-opening a table with an in-flight submitted order returns the same order instead of creating a duplicate", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 1);

    const reopened = await orders.openOrder(waiter, { tableId: fixture.tableId });
    expect(reopened.id).toBe(submitted.id);
    expect(await prisma.order.count({ where: { tableId: fixture.tableId } })).toBe(1);
  });

  it("allows opening a fresh order on the table again after payment completes", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openAndSubmitOrder(fixture, waiter, fixture.menuItemId, 1);
    await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    const next = await orders.openOrder(waiter, { tableId: fixture.tableId });
    expect(next.id).not.toBe(submitted.id);
    expect(next.status).toBe("DRAFT");
  });
});
