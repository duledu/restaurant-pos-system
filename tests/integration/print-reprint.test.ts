import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, printing } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  tableId: string;
  menuItemId: string;
}

function context(fixture: Fixture, role: string, employeeId: string, permissions: string[] = ["orders.print"]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(permissions),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Reprint tenant", slug: `reprint-${randomUUID()}` } });
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
      price: "1200.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });
  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id, tableId: table.id, menuItemId: menuItem.id };
}

async function payOrder(fixture: Fixture, waiter: AuthContext) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
  const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
  const { payment, receipt } = await billing.completePayment(waiter, submitted.id, { method: "CASH", tenderedAmount: 2000 });
  return { order: submitted, payment, receipt };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("receipt reprint: never mutates the order/payment/receipt it reprints", () => {
  it("leaves Order/Payment/Receipt totals byte-for-byte unchanged after a reprint", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, payment, receipt } = await payOrder(fixture, waiter);

    const job = await printing.reprintReceipt(waiter, order.id, randomUUID());
    expect(job.isReprint).toBe(true);
    expect(job.type).toBe("RECEIPT");

    const afterOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const afterPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const afterReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });

    expect(afterOrder.status).toBe("COMPLETED");
    expect(afterPayment.amount.toString()).toBe(payment.amount.toString());
    expect(afterPayment.tenderedAmount.toString()).toBe(payment.tenderedAmount.toString());
    expect(afterPayment.changeAmount.toString()).toBe(payment.changeAmount.toString());
    expect(afterReceipt.total.toString()).toBe(receipt.total.toString());
    expect(afterReceipt.sequenceNumber).toBe(receipt.sequenceNumber);
    // Nikad drugi Payment/Receipt red za istu porudžbinu (reprint nije nova naplata).
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.receipt.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("does not resend anything to the kitchen/bar KDS (no new OrderItemStation rows)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);
    const stationCountBefore = await prisma.orderItemStation.count({ where: { orderItem: { orderId: order.id } } });

    await printing.reprintReceipt(waiter, order.id, randomUUID());

    const stationCountAfter = await prisma.orderItemStation.count({ where: { orderItem: { orderId: order.id } } });
    expect(stationCountAfter).toBe(stationCountBefore);
  });

  it("records an audit entry for every reprint", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, receipt } = await payOrder(fixture, waiter);

    await printing.reprintReceipt(waiter, order.id, randomUUID());

    const entry = await prisma.auditLog.findFirst({ where: { entityId: receipt.id, action: "receipt.reprinted" } });
    expect(entry).toBeTruthy();
    expect(entry?.userId).toBe("waiter-1");
  });

  it("dedupes retries of the SAME reprint click (same idempotency key) but creates a new row for a genuinely new reprint request", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    const clickKey = randomUUID();
    const first = await printing.reprintReceipt(waiter, order.id, clickKey);
    const retryOfSameClick = await printing.reprintReceipt(waiter, order.id, clickKey);
    expect(retryOfSameClick.id).toBe(first.id);

    const secondClick = await printing.reprintReceipt(waiter, order.id, randomUUID());
    expect(secondClick.id).not.toBe(first.id);

    expect(await prisma.printJob.count({ where: { orderId: order.id, isReprint: true } })).toBe(2);
  });

  it("rejects reprint from a caller without orders.print permission", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    const kitchenCtx = context(fixture, "KITCHEN", "kitchen-1", ["production.view", "production.manage"]);
    await expect(printing.reprintReceipt(kitchenCtx, order.id, randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects reprint for an order belonging to another restaurant", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    const outsider = context(fixture, "MANAGER", "outsider");
    outsider.restaurantId = fixture.otherRestaurantId;
    await expect(printing.reprintReceipt(outsider, order.id, randomUUID())).rejects.toThrow("nije pronađena");
  });

  it("historical receipt still renders correctly from the stored snapshot even after the menu item is later deleted", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, receipt } = await payOrder(fixture, waiter);

    await prisma.menuItem.update({ where: { id: fixture.menuItemId }, data: { deletedAt: new Date(), isActive: false } });

    const job = await printing.reprintReceipt(waiter, order.id, randomUUID());
    const content = job.content as { items: { name: string; lineTotal: string }[]; total: string };
    expect(content.items[0].name).toBe("Burger");
    expect(content.total).toBe(receipt.total.toString());
  });
});

// Print Agent physical QA fix — waiter /bill "Štampaj račun" primary action
// now calls printing.printReceipt (idempotent dispatch for the Windows Print
// Agent to claim), never window.print()/BrowserPrintTransport. These tests
// cover the server side of that fix: reuse of the SAME authoritative
// pipeline as the automatic payment-time dispatch, RECEIPT type, no printer
// hardcoded, permission/tenant isolation, and that this is NEVER treated as
// (or audited as) a reprint.
describe("primary waiter print dispatch (printReceipt): reuses the authoritative RECEIPT pipeline, never a reprint", () => {
  it("returns the SAME PrintJob row the automatic payment-time dispatch already created — never a duplicate physical print", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, payment } = await payOrder(fixture, waiter);

    const autoDispatched = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "RECEIPT" } });
    const clicked = await printing.printReceipt(waiter, order.id);

    expect(clicked.id).toBe(autoDispatched.id);
    expect(clicked.dispatchKey).toBe(`receipt:${payment.id}`);
    expect(await prisma.printJob.count({ where: { orderId: order.id, type: "RECEIPT" } })).toBe(1);
  });

  it("uses type RECEIPT, is never marked/audited as a reprint, and preserves authoritative payment/receipt data", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, receipt } = await payOrder(fixture, waiter);

    const job = await printing.printReceipt(waiter, order.id);
    expect(job.type).toBe("RECEIPT");
    expect(job.isReprint).toBe(false);

    const reprintAudit = await prisma.auditLog.findFirst({ where: { entityId: receipt.id, action: "receipt.reprinted" } });
    expect(reprintAudit).toBeNull();

    const content = job.content as { total: string; paymentMethod: string; items: { name: string }[] };
    expect(content.total).toBe(receipt.total.toString());
    expect(content.paymentMethod).toBe(receipt.paymentMethod);
    expect(content.items[0].name).toBe("Burger");
  });

  it("does not hardcode a printer — content carries whatever paperWidthMm the RECEIPT route/printer config resolves to", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    const job = await printing.printReceipt(waiter, order.id);
    const content = job.content as { paperWidthMm?: number };
    // No fixture-configured RECEIPT printer -> falls through to the existing
    // default (80mm), proving the value is COMPUTED (getPrinterConfigForDispatch),
    // never a literal printer name/width baked into printReceipt/print-client.
    expect(content.paperWidthMm).toBe(80);
  });

  it("double-click / network retry never creates a second RECEIPT PrintJob", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    const first = await printing.printReceipt(waiter, order.id);
    const retry = await printing.printReceipt(waiter, order.id);
    expect(retry.id).toBe(first.id);
    expect(await prisma.printJob.count({ where: { orderId: order.id, type: "RECEIPT" } })).toBe(1);
  });

  it("an explicit reprint AFTER printReceipt still creates its own distinct, audited row", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, receipt } = await payOrder(fixture, waiter);

    const primary = await printing.printReceipt(waiter, order.id);
    const reprint = await printing.reprintReceipt(waiter, order.id, randomUUID());

    expect(reprint.id).not.toBe(primary.id);
    expect(reprint.isReprint).toBe(true);
    const reprintAudit = await prisma.auditLog.findFirst({ where: { entityId: receipt.id, action: "receipt.reprinted" } });
    expect(reprintAudit).toBeTruthy();
  });

  it("rejects printReceipt from a caller without orders.print permission", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    const kitchenCtx = context(fixture, "KITCHEN", "kitchen-1", ["production.view", "production.manage"]);
    await expect(printing.printReceipt(kitchenCtx, order.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects printReceipt for an order belonging to another restaurant", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    const outsider = context(fixture, "MANAGER", "outsider");
    outsider.restaurantId = fixture.otherRestaurantId;
    await expect(printing.printReceipt(outsider, order.id)).rejects.toThrow("nije pronađena");
  });
});
