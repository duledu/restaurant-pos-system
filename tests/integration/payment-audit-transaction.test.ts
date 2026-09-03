/**
 * PRODUKCIONI INCIDENT (2026-09) — "Transaction API error: Transaction not
 * found... old closed transaction" na tx.auditLog.create(...) unutar
 * completePayment/paySplitBill. Root cause NIJE pogrešna upotreba `tx`-a
 * (svaki poziv u oba servisa koristi `tx` isključivo unutar callback-a, PRE
 * return-a) — uzrok je Prisma-in podrazumevani 5s interaktivni-transakcijski
 * rok, koji porudžbina sa više stavki/round-trip-ova realno može preći.
 * Rešenje: eksplicitan, velikodušniji `{ maxWait, timeout }` na svakoj
 * teškoj, po-stavci-petlja transakciji (vidi TX_OPTIONS u billing-service.ts/
 * split-bill-service.ts/order-service.ts/transfer-service.ts/
 * inventura-service.ts) — NIKAD premeštanjem Payment/Receipt/audit van
 * transakcije.
 *
 * Ovaj fajl NE pokušava da veštački simulira sam Prisma timeout (to bi
 * zahtevalo usporavanje same baze/mreže — infrastrukturna, ne kod-nivo
 * osobina, i učinilo bi test suite spor/nestabilan). Umesto toga dokazuje
 * ono što STVARNO garantuje ispravnost: da audit UVEK postoji posle uspešne
 * naplate (oba puta), i da je cela transakcija (Payment/PaymentItem/
 * inventar/Receipt/audit/zatvaranje porudžbine) i dalje POTPUNO atomična —
 * gubitnik konkurentne trke ne ostavlja NIKAKAV trag, ni u audit tabeli.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, splitBilling } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  burgerId: string; // 500.00, 20%
  colaId: string; // 300.00, 20%
}

function context(fixture: Fixture, role: string, employeeId: string): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set<string>(),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "PayAudit tenant", slug: `payaudit-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const burger = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Burger", slug: `burger-${randomUUID()}`, price: "500.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const cola = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Cola", slug: `cola-${randomUUID()}`, price: "300.00", taxRate: "20", preparationStation: "BAR" },
  });

  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, burgerId: burger.id, colaId: cola.id };
}

async function openSubmit(fixture: Fixture, waiter: AuthContext, lines: { menuItemId: string; quantity: number }[]) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  for (const line of lines) {
    await orders.addItem(waiter, order.id, { menuItemId: line.menuItemId, quantity: line.quantity });
  }
  return orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("payment audit: normal completePayment", () => {
  it("succeeds and leaves exactly one 'payment.completed' audit row", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.burgerId, quantity: 2 }]);

    const { payment } = await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityId: submitted.id, action: "payment.completed" } });
    expect(entry.userId).toBe(waiter.employeeId);
    expect((entry.newValue as { receiptId: string }).receiptId).toBeTruthy();
    expect(await prisma.receipt.count({ where: { paymentId: payment.id } })).toBe(1);
  });

  it("idempotent retry (same idempotencyKey conceptually via re-call after failure) never duplicates the audit row — rejecting a second payment on an already-paid order leaves audit count at 1", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.burgerId, quantity: 1 }]);

    await billing.completePayment(waiter, submitted.id, { method: "CARD" });
    await expect(billing.completePayment(waiter, submitted.id, { method: "CARD" })).rejects.toThrow("već naplaćena");

    expect(await prisma.auditLog.count({ where: { entityId: submitted.id, action: "payment.completed" } })).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: submitted.id } })).toBe(1);
  });

  it("proves the full transaction (Payment/PaymentItem/Receipt/audit/order-close) is atomic end-to-end: a losing concurrent attempt leaves ZERO trace anywhere, including audit", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.burgerId, quantity: 1 }]);

    const results = await Promise.allSettled([
      billing.completePayment(waiter, submitted.id, { method: "CASH" }),
      billing.completePayment(waiter, submitted.id, { method: "CARD" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    expect(await prisma.payment.count({ where: { orderId: submitted.id } })).toBe(1);
    expect(await prisma.paymentItem.count({ where: { payment: { orderId: submitted.id } } })).toBe(1);
    expect(await prisma.receipt.count({ where: { orderId: submitted.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: submitted.id, action: "payment.completed" } })).toBe(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(order.status).toBe("COMPLETED");
  });
});

describe("payment audit: split-bill paySplitBill", () => {
  it("a partial split payment succeeds and leaves exactly one 'payment.split_completed' audit row, order stays open", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [
      { menuItemId: fixture.burgerId, quantity: 2 },
      { menuItemId: fixture.colaId, quantity: 1 },
    ]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const burgerItem = detail.items.find((i) => i.menuItemId === fixture.burgerId)!;

    const result = await splitBilling.paySplitBill(waiter, submitted.id, {
      idempotencyKey: randomUUID(),
      method: "CARD",
      lines: [{ orderItemId: burgerItem.id, quantity: 1 }],
    });
    expect(result.isFinalPayment).toBe(false);

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityId: submitted.id, action: "payment.split_completed" } });
    expect((entry.newValue as { paymentId: string }).paymentId).toBe(result.payment.id);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(order.status).not.toBe("COMPLETED");
  });

  it("the FINAL split payment that settles everything closes the order and still records its audit row", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.burgerId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const burgerItem = detail.items.find((i) => i.menuItemId === fixture.burgerId)!;

    const result = await splitBilling.paySplitBill(waiter, submitted.id, {
      idempotencyKey: randomUUID(),
      method: "CARD",
      lines: [{ orderItemId: burgerItem.id, quantity: 1 }],
    });
    expect(result.isFinalPayment).toBe(true);

    expect(await prisma.auditLog.count({ where: { entityId: submitted.id, action: "payment.split_completed" } })).toBe(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(order.status).toBe("COMPLETED");
    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("FREE");
  });

  it("a duplicate split-bill retry with the same idempotencyKey never duplicates Payment or audit", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.burgerId, quantity: 2 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const burgerItem = detail.items.find((i) => i.menuItemId === fixture.burgerId)!;
    const idempotencyKey = randomUUID();

    await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey, method: "CARD", lines: [{ orderItemId: burgerItem.id, quantity: 1 }] });
    await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey, method: "CARD", lines: [{ orderItemId: burgerItem.id, quantity: 1 }] });

    expect(await prisma.payment.count({ where: { orderId: submitted.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: submitted.id, action: "payment.split_completed" } })).toBe(1);
  });

  it("proves split-bill's transaction is atomic end-to-end: a losing concurrent attempt on the same remaining quantity leaves zero trace, including audit", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.burgerId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const burgerItem = detail.items.find((i) => i.menuItemId === fixture.burgerId)!;

    const results = await Promise.allSettled([
      splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CASH", lines: [{ orderItemId: burgerItem.id, quantity: 1 }] }),
      splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: burgerItem.id, quantity: 1 }] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    expect(await prisma.payment.count({ where: { orderId: submitted.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: submitted.id, action: "payment.split_completed" } })).toBe(1);
  });
});
