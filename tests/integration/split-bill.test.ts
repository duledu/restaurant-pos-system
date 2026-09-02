/**
 * FAZA 8 — SPLIT BILL (delimično plaćanje porudžbine po stavkama/količini).
 * Vidi packages/domain/billing/split-bill-service.ts za arhitekturu.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma, Prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, splitBilling, voids, ingredients, recipes, inventory, reporting } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  tableId: string;
  biftekId: string; // 1200.00, 20%
  colaId: string; // 300.00, 20%
}

function context(
  fixture: Pick<Fixture, "restaurantId" | "locationId">,
  role: string,
  employeeId: string,
  locationIds = [fixture.locationId],
  permissions = new Set<string>()
): AuthContext {
  return { userId: employeeId, employeeId, restaurantId: fixture.restaurantId, locationIds, roles: [role], permissions };
}

function managerCtx(fixture: Fixture, employeeId = "mgr-1"): AuthContext {
  return context(fixture, "MANAGER", employeeId, [fixture.locationId], new Set(["audit.view", "inventory.view", "inventory.manage"]));
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "SplitBill tenant", slug: `split-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T5" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const biftek = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Biftek", slug: `biftek-${randomUUID()}`, price: "1200.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const cola = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Coca-Cola", slug: `cola-${randomUUID()}`, price: "300.00", taxRate: "20", preparationStation: "BAR" },
  });

  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id, tableId: table.id, biftekId: biftek.id, colaId: cola.id };
}

async function openSubmit(fixture: Fixture, waiter: AuthContext, lines: { menuItemId: string; quantity: number; modifierOptionIds?: string[] }[]) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  for (const line of lines) {
    await orders.addItem(waiter, order.id, { menuItemId: line.menuItemId, quantity: line.quantity, modifierOptionIds: line.modifierOptionIds ?? [] });
  }
  return orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("split bill: pay by item / quantity", () => {
  it("pays a selected whole item, leaves the rest unpaid (Order stays open)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [
      { menuItemId: fixture.biftekId, quantity: 2 },
      { menuItemId: fixture.colaId, quantity: 1 },
    ]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const biftekItem = detail.items.find((i) => i.menuItemId === fixture.biftekId)!;

    const result = await splitBilling.paySplitBill(waiter, submitted.id, {
      idempotencyKey: randomUUID(),
      method: "CARD",
      lines: [{ orderItemId: biftekItem.id, quantity: 1 }],
    });

    expect(result.payment.amount.toString()).toBe("1440"); // 1200 subtotal + 240 tax
    expect(result.isFinalPayment).toBe(false);
    expect(result.order.status).not.toBe("COMPLETED");

    const preview = await splitBilling.getSplitBillPreview(waiter, submitted.id);
    expect(preview.fullyPaid).toBe(false);
    const remainingBiftek = preview.items.find((i) => i.orderItemId === biftekItem.id)!;
    expect(remainingBiftek.remaining).toBe(1);
    const remainingCola = preview.items.find((i) => i.name === "Coca-Cola")!;
    expect(remainingCola.remaining).toBe(1);

    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("OCCUPIED"); // sto ostaje zauzet dok nije sve naplaćeno
  });

  it("pays a partial quantity from a multi-quantity item — remaining stays unpaid at quantity level", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.colaId, quantity: 3 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const colaItem = detail.items[0];

    await splitBilling.paySplitBill(waiter, submitted.id, {
      idempotencyKey: randomUUID(),
      method: "CASH",
      lines: [{ orderItemId: colaItem.id, quantity: 1 }],
    });

    const reloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: colaItem.id } });
    expect(reloaded.quantity).toBe(3); // quantity se NE menja pri naplati
    expect(reloaded.paidQuantity).toBe(1);

    const preview = await splitBilling.getSplitBillPreview(waiter, submitted.id);
    expect(preview.items[0].remaining).toBe(2);
  });

  it("the final partial payment that settles every remaining quantity closes the order and frees the table exactly once", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.colaId, quantity: 2 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const colaItem = detail.items[0];

    const first = await splitBilling.paySplitBill(waiter, submitted.id, {
      idempotencyKey: randomUUID(),
      method: "CASH",
      lines: [{ orderItemId: colaItem.id, quantity: 1 }],
    });
    expect(first.isFinalPayment).toBe(false);

    const final = await splitBilling.paySplitBill(waiter, submitted.id, {
      idempotencyKey: randomUUID(),
      method: "CARD",
      lines: [{ orderItemId: colaItem.id, quantity: 1 }],
    });
    expect(final.isFinalPayment).toBe(true);
    expect(final.order.status).toBe("COMPLETED");

    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("FREE");

    // Order-level total (2 payments) matches what a single full payment would have been.
    const payments = await prisma.payment.findMany({ where: { orderId: submitted.id } });
    expect(payments).toHaveLength(2);
    const totalCollected = payments.reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));
    expect(totalCollected.toString()).toBe("720"); // 2 * 300 + 20% tax = 720
  });

  it("rejects paying an already-CANCELLED (fully voided) item", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.colaId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const colaItem = detail.items[0];

    await voids.voidOrderItem(manager, submitted.id, colaItem.id, {
      quantity: 1,
      reasonCode: "OTHER",
      explanation: "Customer changed their mind before payment, confirmed with manager.",
    });

    await expect(
      splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: colaItem.id, quantity: 1 }] })
    ).rejects.toThrow("poništena");
  });
});

describe("split bill: idempotency & concurrency", () => {
  it("a duplicate payment retry with the same idempotencyKey does not double-charge", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.colaId, quantity: 2 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const colaItem = detail.items[0];
    const key = randomUUID();
    const input = { idempotencyKey: key, method: "CARD" as const, lines: [{ orderItemId: colaItem.id, quantity: 1 }] };

    const first = await splitBilling.paySplitBill(waiter, submitted.id, input);
    const retry = await splitBilling.paySplitBill(waiter, submitted.id, input);

    expect(retry.payment.id).toBe(first.payment.id);
    expect(await prisma.payment.count({ where: { orderId: submitted.id } })).toBe(1);
    const reloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: colaItem.id } });
    expect(reloaded.paidQuantity).toBe(1); // ne 2 — retry nije naplatio ponovo
  });

  it("coalesces two concurrent requests with the same idempotency key", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.colaId, quantity: 2 }]);
    const item = (await orders.getOrder(waiter, submitted.id)).items[0];
    const input = { idempotencyKey: randomUUID(), method: "CARD" as const, lines: [{ orderItemId: item.id, quantity: 1 }] };

    const [first, second] = await Promise.all([
      splitBilling.paySplitBill(waiter, submitted.id, input),
      splitBilling.paySplitBill(waiter, submitted.id, input),
    ]);

    expect(second.payment.id).toBe(first.payment.id);
    expect(await prisma.payment.count({ where: { orderId: submitted.id } })).toBe(1);
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).paidQuantity).toBe(1);
  });

  it("allows only one of two concurrent payments that both target the same remaining quantity to commit", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.colaId, quantity: 2 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const colaItem = detail.items[0];

    const results = await Promise.allSettled([
      splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: colaItem.id, quantity: 2 }] }),
      splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CASH", lines: [{ orderItemId: colaItem.id, quantity: 2 }] }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const reloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: colaItem.id } });
    expect(reloaded.paidQuantity).toBe(2); // tačno jednom naplaćeno, ne dupliran efekat
    expect(await prisma.payment.count({ where: { orderId: submitted.id } })).toBe(1);
  });

  it("atomically completes exactly once when concurrent payments settle different remaining items", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [
      { menuItemId: fixture.biftekId, quantity: 1 },
      { menuItemId: fixture.colaId, quantity: 1 },
    ]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const biftek = detail.items.find((item) => item.menuItemId === fixture.biftekId)!;
    const cola = detail.items.find((item) => item.menuItemId === fixture.colaId)!;

    const results = await Promise.all([
      splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: biftek.id, quantity: 1 }] }),
      splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CASH", lines: [{ orderItemId: cola.id, quantity: 1 }] }),
    ]);

    expect(results.filter((result) => result.isFinalPayment)).toHaveLength(1);
    expect(await prisma.payment.count({ where: { orderId: submitted.id } })).toBe(2);
    expect(await prisma.paymentItem.count({ where: { payment: { orderId: submitted.id } } })).toBe(2);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: submitted.id } })).status).toBe("COMPLETED");
    expect((await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } })).status).toBe("FREE");
    expect(await prisma.orderEvent.count({ where: { orderId: submitted.id, type: "order_fully_settled" } })).toBe(1);
  });
});

describe("split bill: inventory / ingredient deduction", () => {
  it("deducts DIRECT_STOCK inventory only for the quantity actually paid in each split payment", async () => {
    const fixture = await createFixture();
    const owner = managerCtx(fixture, "owner-1");
    const waiter = context(fixture, "WAITER", "waiter-1");
    await inventory.initializeTracking(owner, { menuItemId: fixture.colaId, locationId: fixture.locationId, initialStock: 10 });

    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.colaId, quantity: 3 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const colaItem = detail.items[0];

    await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: colaItem.id, quantity: 1 }] });
    let invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    expect(invItem.currentStock.toString()).toBe("9"); // samo 1 odbijena, ne sve 3

    await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CASH", lines: [{ orderItemId: colaItem.id, quantity: 2 }] });
    invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    expect(invItem.currentStock.toString()).toBe("7");

    // Tačno 2 SALE kretanja (jedno po Payment-u), nikad jedno na celih 3.
    const movements = await prisma.inventoryMovement.findMany({ where: { menuItemId: fixture.colaId, type: "SALE" } });
    expect(movements).toHaveLength(2);
    expect(movements.map((m) => m.quantityDelta.toString()).sort()).toEqual(["-1", "-2"]);
  });

  it("deducts RECIPE ingredients only for the quantity actually paid in each split payment", async () => {
    const fixture = await createFixture();
    const owner = managerCtx(fixture, "owner-1");
    const waiter = context(fixture, "WAITER", "waiter-1");
    const meat = await ingredients.createIngredient(owner, { name: "Meso", unit: "KILOGRAM" });
    await ingredients.initializeStock(owner, { ingredientId: meat.id, locationId: fixture.locationId, initialStock: 10 });
    await recipes.addRecipeLine(owner, fixture.biftekId, { ingredientId: meat.id, quantity: 0.3 });

    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.biftekId, quantity: 3 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const biftekItem = detail.items[0];

    await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: biftekItem.id, quantity: 1 }] });
    let stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(stock.currentStock.toString()).toBe("9.7"); // 10 - 0.3 (samo za 1 porciju)

    await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CASH", lines: [{ orderItemId: biftekItem.id, quantity: 2 }] });
    stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(stock.currentStock.toString()).toBe("9.1"); // - 0.6 dodatno (2 porcije)
  });
});

describe("split bill: modifiers & receipts", () => {
  it("preserves modifiers on the paid line and reflects them on that payment's receipt", async () => {
    const fixture = await createFixture();
    const owner = managerCtx(fixture, "owner-1");
    const waiter = context(fixture, "WAITER", "waiter-1");
    const group = await prisma.modifierGroup.create({ data: { restaurantId: fixture.restaurantId, name: "Dodaci", required: false, minSelect: 0, maxSelect: 3 } });
    const option = await prisma.modifierOption.create({ data: { modifierGroupId: group.id, name: "Extra sir", priceDelta: "100" } });
    await prisma.menuItemModifierGroup.create({ data: { menuItemId: fixture.biftekId, modifierGroupId: group.id } });
    void owner;

    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.biftekId, quantity: 1, modifierOptionIds: [option.id] }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const item = detail.items[0];
    expect(item.price.toString()).toBe("1300"); // 1200 + 100 modifier

    const { receipt } = await splitBilling.paySplitBill(waiter, submitted.id, {
      idempotencyKey: randomUUID(),
      method: "CARD",
      lines: [{ orderItemId: item.id, quantity: 1 }],
    });

    const items = receipt!.items as unknown as { name: string; modifiers: { name: string }[] }[];
    expect(items).toHaveLength(1);
    expect(items[0].modifiers.map((m) => m.name)).toContain("Extra sir");
  });

  it("shows only the paid portion on the receipt, not the whole order", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [
      { menuItemId: fixture.biftekId, quantity: 1 },
      { menuItemId: fixture.colaId, quantity: 1 },
    ]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const biftekItem = detail.items.find((i) => i.menuItemId === fixture.biftekId)!;

    const { receipt } = await splitBilling.paySplitBill(waiter, submitted.id, {
      idempotencyKey: randomUUID(),
      method: "CARD",
      lines: [{ orderItemId: biftekItem.id, quantity: 1 }],
    });

    expect(receipt!.total.toString()).toBe("1440"); // samo Biftek, ne i Cola
    const items = receipt!.items as unknown as { name: string }[];
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Biftek");
  });
});

describe("split bill: discount proration", () => {
  it("splits an order-level discount across split payments so the sum exactly equals the discount", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.colaId, quantity: 2 }]);
    await billing.applyOrderDiscount(manager, submitted.id, { amount: 100, reason: "Loyalty discount" });

    const detail = await orders.getOrder(waiter, submitted.id);
    const colaItem = detail.items[0];

    const first = await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: colaItem.id, quantity: 1 }] });
    const second = await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CASH", lines: [{ orderItemId: colaItem.id, quantity: 1 }] });

    const discount1 = Number(first.payment.discountAmount ?? 0);
    const discount2 = Number(second.payment.discountAmount ?? 0);
    expect(Math.round((discount1 + discount2) * 100) / 100).toBe(100);
    expect(second.isFinalPayment).toBe(true);

    // 2 * (300 + 60 tax) = 720 total before discount, -100 discount = 620.
    const totalPaid = Number(first.payment.amount) + Number(second.payment.amount);
    expect(totalPaid).toBe(620);
  });

  it("allocates the exact discount once when different final items are paid concurrently", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const submitted = await openSubmit(fixture, waiter, [
      { menuItemId: fixture.biftekId, quantity: 1 },
      { menuItemId: fixture.colaId, quantity: 1 },
    ]);
    await billing.applyOrderDiscount(manager, submitted.id, { amount: 100.01, reason: "Concurrent rounding test" });
    const detail = await orders.getOrder(waiter, submitted.id);
    const biftek = detail.items.find((item) => item.menuItemId === fixture.biftekId)!;
    const cola = detail.items.find((item) => item.menuItemId === fixture.colaId)!;

    await Promise.all([
      splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: biftek.id, quantity: 1 }] }),
      splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CASH", lines: [{ orderItemId: cola.id, quantity: 1 }] }),
    ]);

    const discounts = await prisma.payment.findMany({ where: { orderId: submitted.id }, select: { discountAmount: true } });
    const allocated = discounts.reduce((sum, payment) => sum.add(payment.discountAmount ?? 0), new Prisma.Decimal(0));
    expect(allocated.equals(new Prisma.Decimal("100.01"))).toBe(true);
  });
});

describe("split bill: reporting", () => {
  it("sums split payments correctly in the sales summary without double-counting revenue or orders", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const submitted = await openSubmit(fixture, waiter, [
      { menuItemId: fixture.biftekId, quantity: 1 },
      { menuItemId: fixture.colaId, quantity: 1 },
    ]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const biftekItem = detail.items.find((i) => i.menuItemId === fixture.biftekId)!;
    const colaItem = detail.items.find((i) => i.menuItemId === fixture.colaId)!;

    // Mešoviti načini plaćanja preko dva konobara.
    await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CASH", lines: [{ orderItemId: biftekItem.id, quantity: 1 }] });
    const waiter2 = context(fixture, "WAITER", "waiter-2");
    await splitBilling.paySplitBill(waiter2, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: colaItem.id, quantity: 1 }] });

    const summary = await reporting.getSalesSummary(manager, { locationId: fixture.locationId, preset: "today" });
    const employeeSales = await reporting.getSalesByEmployee(manager, { locationId: fixture.locationId, preset: "today" });
    expect(summary.totalSales).toBe("1800"); // 1440 + 360, no double counting
    expect(summary.completedOrders).toBe(1); // ISTA porudžbina, ne 2 (broji porudžbine, ne Payment redove)
    expect(summary.cashSales).toBe("1440");
    expect(summary.cardSales).toBe("360");
    expect(employeeSales.reduce((count, row) => count + row.payments, 0)).toBe(2);
  });
});

describe("split bill: void interaction", () => {
  it("prevents voiding an already-paid quantity, but allows voiding the unpaid remainder", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.colaId, quantity: 2 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const colaItem = detail.items[0];

    await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: colaItem.id, quantity: 1 }] });

    await expect(
      voids.voidOrderItem(manager, submitted.id, colaItem.id, { quantity: 2, reasonCode: "OTHER", explanation: "Trying to void more than remains unpaid." })
    ).rejects.toThrow("neplaćenog ostatka");

    await expect(
      voids.voidOrderItem(manager, submitted.id, colaItem.id, { quantity: 1, reasonCode: "OTHER", explanation: "Voiding only the unpaid remaining unit." })
    ).resolves.toBeTruthy();

    const reloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: colaItem.id } });
    expect(reloaded.paidQuantity).toBe(1);
    expect(reloaded.quantity).toBe(1); // 2 - 1 voided
  });
});

describe("split bill: cross-restaurant safety", () => {
  it("rejects a split bill preview and payment attempt from another restaurant", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(fixture, waiter, [{ menuItemId: fixture.colaId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const colaItem = detail.items[0];

    const outsider = context(fixture, "MANAGER", "outsider");
    outsider.restaurantId = fixture.otherRestaurantId;

    await expect(splitBilling.getSplitBillPreview(outsider, submitted.id)).rejects.toThrow("nije pronađena");
    await expect(
      splitBilling.paySplitBill(outsider, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: colaItem.id, quantity: 1 }] })
    ).rejects.toThrow("nije pronađena");
  });
});
