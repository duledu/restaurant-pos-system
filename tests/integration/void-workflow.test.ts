import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { orders, voids, billing, audit } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  tableId: string;
  menuItemId: string;
}

function context(fixture: Fixture, role: string, employeeId: string, locationIds = [fixture.locationId]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds,
    roles: [role],
    permissions: new Set(["audit.view"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Void tenant", slug: `void-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Other" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });

  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, openedBy: "manager" } });

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

  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    tableId: table.id,
    menuItemId: menuItem.id,
  };
}

async function submitOrderWithQuantity(fixture: Fixture, waiter: AuthContext, quantity: number) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity });
  const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
  return { order: submitted, item };
}

const VALID_EXPLANATION = "Entered 2 instead of 1 by mistake, correcting before service.";

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("draft behavior (unaffected by Phase 4)", () => {
  it("allows a waiter to add, update quantity, and remove an unsent draft item freely", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 2 });

    const updated = await orders.updateItem(waiter, order.id, item.id, { quantity: 3 });
    expect(updated.quantity).toBe(3);

    await orders.removeItem(waiter, order.id, item.id);
    const remaining = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(remaining).toHaveLength(0);
  });
});

describe("submitted item is protected from normal edit/delete", () => {
  it("rejects removeItem on a submitted item and records an audit entry", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 2);

    await expect(orders.removeItem(waiter, order.id, item.id)).rejects.toThrow("ne može se menjati");

    const entry = await prisma.auditLog.findFirst({
      where: { entityId: order.id, action: "order_item.mutation_attempt_rejected" },
    });
    expect(entry).toBeTruthy();
    expect(entry?.category).toBe("UNAUTHORIZED_ATTEMPT");
    expect(entry?.isSuspicious).toBe(true);
  });

  it("rejects updateItem (silent quantity reduction) on a submitted item", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 2);

    await expect(orders.updateItem(waiter, order.id, item.id, { quantity: 1 })).rejects.toThrow("ne može se menjati");
    const reloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloaded.quantity).toBe(2); // nepromenjeno — nema tihe redukcije
  });
});

describe("void: core behavior", () => {
  it("performs a valid partial void, preserving original/corrected quantities and computing correct value", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 2);

    const result = await voids.voidOrderItem(manager, order.id, item.id, {
      quantity: 1,
      reasonCode: "WRONG_QUANTITY",
      explanation: VALID_EXPLANATION,
    });

    expect(result.quantityBefore).toBe(2);
    expect(result.voidedQuantity).toBe(1);
    expect(result.quantityAfter).toBe(1);
    expect(result.voidedValue.toString()).toBe("1200");
    expect(result.unitPrice.toString()).toBe("1200");
    expect(result.reasonCode).toBe("WRONG_QUANTITY");
    expect(result.explanation).toBe(VALID_EXPLANATION);

    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloadedItem.quantity).toBe(1);
    expect(reloadedItem.status).not.toBe("CANCELLED"); // partial void ne otkazuje stavku
  });

  it("performs a full void, marking the item CANCELLED", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    const result = await voids.voidOrderItem(manager, order.id, item.id, {
      quantity: 1,
      reasonCode: "CUSTOMER_CHANGED_MIND",
      explanation: VALID_EXPLANATION,
    });
    expect(result.quantityAfter).toBe(0);

    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloadedItem.status).toBe("CANCELLED");
    expect(reloadedItem.quantity).toBe(0);
  });

  it("rejects a void whose quantity exceeds the remaining quantity", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    await expect(
      voids.voidOrderItem(manager, order.id, item.id, { quantity: 5, reasonCode: "WRONG_QUANTITY", explanation: VALID_EXPLANATION })
    ).rejects.toThrow("veća od preostale količine");
  });

  it("rejects a meaningless explanation", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 2);

    for (const junk of [".", "-", "x", "test", "   ", "short"]) {
      await expect(
        voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: junk })
      ).rejects.toThrow("smisleno");
    }
  });

  it("rejects voiding an already fully-voided item", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);
    await voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: VALID_EXPLANATION });

    await expect(
      voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: VALID_EXPLANATION })
    ).rejects.toThrow("već poništena");
  });

  it("keeps the historical unit price even after the menu price later changes", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    await prisma.menuItem.update({ where: { id: fixture.menuItemId }, data: { price: "9999.00" } });

    const result = await voids.voidOrderItem(manager, order.id, item.id, {
      quantity: 1,
      reasonCode: "WRONG_ITEM",
      explanation: VALID_EXPLANATION,
    });
    expect(result.unitPrice.toString()).toBe("1200");
    expect(result.voidedValue.toString()).toBe("1200");
  });
});

describe("void: permissions", () => {
  it("rejects a waiter attempting a void and records the rejected attempt", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    await expect(
      voids.voidOrderItem(waiter, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: VALID_EXPLANATION })
    ).rejects.toBeInstanceOf(ForbiddenError);

    const entry = await prisma.auditLog.findFirst({
      where: { entityId: item.id, action: "order_item.void_attempt_rejected" },
    });
    expect(entry).toBeTruthy();
    expect(entry?.category).toBe("UNAUTHORIZED_ATTEMPT");
  });

  it.each(["OWNER", "ADMIN", "MANAGER"])("allows %s to void a submitted item", async (role) => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, role, `mgr-${role}`);
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    await expect(
      voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: VALID_EXPLANATION })
    ).resolves.toBeTruthy();
  });

  it("rejects a cross-restaurant void attempt", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    const outsider = context(fixture, "MANAGER", "outsider");
    outsider.restaurantId = fixture.otherRestaurantId;
    await expect(
      voids.voidOrderItem(outsider, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: VALID_EXPLANATION })
    ).rejects.toThrow("nije pronađena");
  });

  it("rejects a cross-location void attempt", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    const outsider = context(fixture, "MANAGER", "outsider", [fixture.otherLocationId]);
    await expect(
      voids.voidOrderItem(outsider, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: VALID_EXPLANATION })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("void: audit evidence", () => {
  it("creates a reconstructable audit trail for a successful void", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 2);

    await voids.voidOrderItem(manager, order.id, item.id, {
      quantity: 1,
      reasonCode: "WRONG_QUANTITY",
      explanation: VALID_EXPLANATION,
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: item.id, action: "order_item.voided_partial" },
    });
    expect(entry.userId).toBe("mgr-1");
    expect(entry.role).toBe("MANAGER");
    expect(entry.reason).toBe("WRONG_QUANTITY");
    expect((entry.previousValue as { quantity: number }).quantity).toBe(2);
    expect((entry.newValue as { quantity: number }).quantity).toBe(1);
    expect((entry.newValue as { explanation: string }).explanation).toBe(VALID_EXPLANATION);

    const voidRow = await prisma.orderItemVoid.findFirstOrThrow({ where: { orderItemId: item.id } });
    expect(voidRow.voidedBy).toBe("mgr-1");
    expect(voidRow.voidedByRole).toBe("MANAGER");
    expect(voidRow.tableLabel).toBe("T1");
  });

  it("flags a high-value void as suspicious with HIGH severity", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    // 1200 * 3 = 3600 >= 3000 threshold
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 3);

    await voids.voidOrderItem(manager, order.id, item.id, {
      quantity: 3,
      reasonCode: "OTHER",
      explanation: VALID_EXPLANATION,
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: item.id, action: "order_item.voided_full" },
    });
    expect(entry.severity).toBe("HIGH");
    expect(entry.isSuspicious).toBe(true);
  });

  it("surfaces frequent voids by one employee via getSuspiciousActivity", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const floor = await prisma.floor.findFirstOrThrow({ where: { restaurantId: fixture.restaurantId, locationId: fixture.locationId } });

    for (let i = 0; i < 5; i++) {
      // Nova tabela po iteraciji — openOrder namerno vraća POSTOJEĆU aktivnu
      // porudžbinu za isti sto (Faza 2 dedup), pa bismo bez ovoga stalno
      // dobijali istu (već SUBMITTED) porudžbinu umesto 5 nezavisnih.
      const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: `Void-${i}` } });
      const order = await orders.openOrder(waiter, { tableId: table.id });
      const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
      const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
      await voids.voidOrderItem(manager, submitted.id, item.id, {
        quantity: 1,
        reasonCode: "WRONG_QUANTITY",
        explanation: VALID_EXPLANATION,
      });
    }

    const signals = await audit.getSuspiciousActivity(manager, { locationId: fixture.locationId });
    const frequent = signals.find((s) => s.category === "FREQUENT_VOIDS" && s.employeeId === "mgr-1");
    expect(frequent).toBeTruthy();
    expect(frequent?.count).toBe(5);

    const repeated = signals.find((s) => s.category === "REPEATED_VOID_REASON" && s.employeeId === "mgr-1");
    expect(repeated).toBeTruthy();
  });
});

describe("void: protects paid orders", () => {
  it("rejects voiding an item on a COMPLETED (paid) order and leaves payment/receipt untouched", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);
    const { payment, receipt } = await billing.completePayment(waiter, order.id, { method: "CARD" });

    await expect(
      voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: VALID_EXPLANATION })
    ).rejects.toThrow("plaćena/otkazana");

    const reloadedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const reloadedReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(reloadedPayment.amount.toString()).toBe(payment.amount.toString());
    expect(reloadedReceipt.total.toString()).toBe(receipt.total.toString());
    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloadedItem.quantity).toBe(1); // nepromenjeno
  });
});

describe("void: concurrency", () => {
  it("allows only one of two concurrent void attempts on the same item to commit", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    const results = await Promise.allSettled([
      voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: VALID_EXPLANATION }),
      voids.voidOrderItem(manager, order.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: VALID_EXPLANATION }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloadedItem.quantity).toBe(0); // ne negativno, tačno jedan void primenjen
    expect(await prisma.orderItemVoid.count({ where: { orderItemId: item.id } })).toBe(1);
  });
});

describe("void: kitchen/bar production history", () => {
  it("cancels active station state on a full void without erasing production history", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const kitchen = context(fixture, "KITCHEN", "kitchen-1");
    kitchen.permissions = new Set(["production.view", "production.manage"]);
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    // Kuhinja započinje pripremu (SUBMITTED -> ACCEPTED -> PREPARING) PRE poništavanja.
    const { production } = await import("@rcs/domain");
    await production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "SUBMITTED");
    await production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "ACCEPTED");
    const preparingState = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.id } });
    expect(preparingState.status).toBe("PREPARING");

    await voids.voidOrderItem(manager, order.id, item.id, {
      quantity: 1,
      reasonCode: "CUSTOMER_CHANGED_MIND",
      explanation: VALID_EXPLANATION,
    });

    const cancelledState = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.id } });
    expect(cancelledState.status).toBe("CANCELLED");

    // Istorija pripreme (koliko je stanje odmaklo pre poništavanja) ostaje
    // vidljiva kroz OrderEvent trag — nije obrisana.
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    expect(events.some((e) => e.type === "order_item.status_changed")).toBe(true);
    expect(events.some((e) => e.type === "item_voided")).toBe(true);

    // Kuhinja koja pokuša da nastavi (stale expectedStatus) korektno biva odbijena —
    // stavka je već otkazana, ne "PREPARING" kako je kuhinja mislila.
    await expect(
      production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "PREPARING")
    ).rejects.toThrow("već promenjen");
  });

  it("leaves station state untouched on a partial void — kitchen still sees the reduced quantity", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const kitchen = context(fixture, "KITCHEN", "kitchen-1");
    kitchen.permissions = new Set(["production.view", "production.manage"]);
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 2);

    const { production } = await import("@rcs/domain");
    await production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "SUBMITTED");

    await voids.voidOrderItem(manager, order.id, item.id, {
      quantity: 1,
      reasonCode: "WRONG_QUANTITY",
      explanation: VALID_EXPLANATION,
    });

    const stationState = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.id } });
    expect(stationState.status).toBe("ACCEPTED"); // nepromenjeno void-om, i dalje aktivno

    const kitchenView = await production.listStationOrders(kitchen, fixture.locationId, "KITCHEN");
    const visibleItem = kitchenView[0]?.items.find((i) => i.id === item.id);
    expect(visibleItem?.quantity).toBe(1); // kuhinja vidi ažuriranu (umanjenu) količinu
  });
});

/**
 * cancelAbandonedOrder — otkazivanje CELE napuštene porudžbine (razvojni/
 * testni "zaboravljen otvoren sto" ili budući admin "oslobodi sto" tok).
 * Namerno odvojeno od voidOrderItem (poništava jednu poslatu stavku); ovde
 * se cela porudžbina zatvara bez naplate. Nijedan Payment/Receipt se ne sme
 * kreirati, Order/OrderItem redovi se ne brišu, i sto se oslobađa.
 */
describe("cancelAbandonedOrder: permissions", () => {
  it("rejects a waiter and records the rejected attempt", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    await expect(
      voids.cancelAbandonedOrder(waiter, order.id, { reason: "Development cleanup — release stuck table" })
    ).rejects.toBeInstanceOf(ForbiddenError);

    const entry = await prisma.auditLog.findFirst({
      where: { entityId: order.id, action: "order.cancel_attempt_rejected" },
    });
    expect(entry).toBeTruthy();
    expect(entry?.category).toBe("UNAUTHORIZED_ATTEMPT");
    expect(entry?.isSuspicious).toBe(true);

    // Porudžbina i sto ostaju netaknuti nakon odbijenog pokušaja.
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe("DRAFT");
  });

  it.each(["OWNER", "ADMIN", "MANAGER"])("allows %s to cancel an abandoned order", async (role) => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, role, `mgr-${role}`);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    await expect(
      voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" })
    ).resolves.toEqual({ orderId: order.id, status: "CANCELLED" });
  });

  it("rejects a cross-restaurant cancellation attempt", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    const outsider = context(fixture, "MANAGER", "outsider");
    outsider.restaurantId = fixture.otherRestaurantId;
    await expect(
      voids.cancelAbandonedOrder(outsider, order.id, { reason: "Development cleanup — release stuck table" })
    ).rejects.toThrow("nije pronađena");
  });

  it("rejects a cross-location cancellation attempt", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    const outsider = context(fixture, "MANAGER", "outsider", [fixture.otherLocationId]);
    await expect(
      voids.cancelAbandonedOrder(outsider, order.id, { reason: "Development cleanup — release stuck table" })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects a missing or too-short reason", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    await expect(voids.cancelAbandonedOrder(manager, order.id, { reason: "  " })).rejects.toThrow("smislen");
    await expect(voids.cancelAbandonedOrder(manager, order.id, { reason: "hi" })).rejects.toThrow("smislen");
  });
});

describe("cancelAbandonedOrder: core behavior", () => {
  it("cancels a never-submitted DRAFT order and releases the table, preserving the Order/OrderItem rows", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });

    await voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" });

    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloadedOrder.status).toBe("CANCELLED");

    // Redovi ostaju (ne brišu se) — samo status.
    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloadedItem.status).toBe("CANCELLED");

    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("FREE");
  });

  it("cancels a SUBMITTED order, cancels its OrderItemStation rows (KDS), and releases the table", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    const stationBefore = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.id } });
    expect(stationBefore.status).toBe("SUBMITTED");

    await voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" });

    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloadedOrder.status).toBe("CANCELLED");
    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloadedItem.status).toBe("CANCELLED");
    const stationAfter = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.id } });
    expect(stationAfter.status).toBe("CANCELLED");

    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("FREE");
  });

  it("does not touch station state that is already SERVED", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const kitchen = context(fixture, "KITCHEN", "kitchen-1");
    kitchen.permissions = new Set(["production.view", "production.manage"]);
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order, item } = await submitOrderWithQuantity(fixture, waiter, 1);

    const { production } = await import("@rcs/domain");
    await production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "SUBMITTED");
    await production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "ACCEPTED");
    await production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "PREPARING");
    await production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "READY");
    await production.advanceItemStatus(kitchen, order.id, item.id, "KITCHEN", "SERVED");

    await voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" });

    const station = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.id } });
    expect(station.status).toBe("SERVED"); // već served — cancelAbandonedOrder ga ne dira
  });

  it("writes an order_cancelled OrderEvent and an order.cancelled audit entry in the same transaction", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    await voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" });

    const event = await prisma.orderEvent.findFirstOrThrow({ where: { orderId: order.id, type: "order_cancelled" } });
    expect(event.createdBy).toBe("mgr-1");
    expect((event.payload as { reason: string }).reason).toBe("Development cleanup — release stuck table");

    const auditEntry = await prisma.auditLog.findFirstOrThrow({ where: { entityId: order.id, action: "order.cancelled" } });
    expect(auditEntry.userId).toBe("mgr-1");
    expect(auditEntry.role).toBe("MANAGER");
    expect(auditEntry.reason).toBe("Development cleanup — release stuck table");
    expect((auditEntry.previousValue as { status: string }).status).toBe("DRAFT");
    expect((auditEntry.newValue as { status: string }).status).toBe("CANCELLED");
  });

  it("creates no Payment, no Receipt, and no InventoryMovement as a side effect", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order } = await submitOrderWithQuantity(fixture, waiter, 1);

    await voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" });

    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
    expect(await prisma.receipt.count({ where: { orderId: order.id } })).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe("cancelAbandonedOrder: protects paid orders and rejects repeat/invalid state", () => {
  it("rejects cancelling an already-COMPLETED (paid) order, leaving payment/receipt untouched", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order } = await submitOrderWithQuantity(fixture, waiter, 1);
    const { payment, receipt } = await billing.completePayment(waiter, order.id, { method: "CASH" });

    await expect(
      voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" })
    ).rejects.toThrow("već zatvorena");

    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloadedOrder.status).toBe("COMPLETED");
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toBeTruthy();
    expect(await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).toBeTruthy();
  });

  it("rejects cancelling an order that is already CANCELLED (repeated invocation is safely rejected)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    await voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" });
    await expect(
      voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" })
    ).rejects.toThrow("već zatvorena");
  });
});

describe("cancelAbandonedOrder: concurrency", () => {
  it("allows only one of two concurrent cancellations on the same order to commit", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });

    const results = await Promise.allSettled([
      voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" }),
      voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloadedOrder.status).toBe("CANCELLED"); // tačno jedno otkazivanje primenjeno, ne dupliran efekat

    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("FREE");
  });

  it("a completePayment that wins the race leaves cancelAbandonedOrder safely rejected (no cancelled-but-paid order)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const { order } = await submitOrderWithQuantity(fixture, waiter, 1);

    const results = await Promise.allSettled([
      billing.completePayment(waiter, order.id, { method: "CASH" }),
      voids.cancelAbandonedOrder(manager, order.id, { reason: "Development cleanup — release stuck table" }),
    ]);

    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // Bez obzira koja je operacija pobedila u trci, porudžbina nikad ne sme
    // završiti kao "i naplaćena i otkazana" — tačno jedno stanje pobeđuje.
    expect(["COMPLETED", "CANCELLED"]).toContain(reloadedOrder.status);
    const paymentCount = await prisma.payment.count({ where: { orderId: order.id } });
    if (reloadedOrder.status === "COMPLETED") {
      expect(paymentCount).toBe(1);
    } else {
      expect(paymentCount).toBe(0);
    }
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
