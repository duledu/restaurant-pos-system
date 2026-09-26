/**
 * Promotions & Pricing Engine V1 — Happy Hour and rule-based scheduled
 * pricing. See packages/domain/promotions/promotion-service.ts and
 * packages/shared/promotion-schedule.ts (the pure schedule/precedence logic
 * is already exhaustively covered by tests/unit/promotion-schedule.test.ts —
 * this file focuses on DB-backed integration: CRUD, permissions, audit, and
 * the full addItem/submitOrder pricing pipeline including historical
 * snapshot preservation and downstream (Payment/Receipt/KDS/Inventory)
 * side-effect safety).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError, type AuthContext } from "@rcs/auth";
import { orders, billing, promotions } from "@rcs/domain";
import { resolveEffectivePrice } from "../../packages/domain/promotions/promotion-service";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  shiftId: string;
  categoryId: string;
  otherCategoryId: string;
  menuItemId: string; // "Mojito", 600.00, BAR, in categoryId
}

function context(fixture: Pick<Fixture, "restaurantId" | "locationId">, role: string, employeeId: string, permissions = new Set<string>()): AuthContext {
  return { userId: employeeId, employeeId, restaurantId: fixture.restaurantId, locationIds: [fixture.locationId], roles: [role], permissions };
}

function managerCtx(fixture: Fixture, employeeId = "mgr-1"): AuthContext {
  return context(fixture, "MANAGER", employeeId, new Set(["promotions.view", "promotions.manage", "orders.print", "audit.view"]));
}
function waiterCtx(fixture: Fixture, employeeId = "waiter-1"): AuthContext {
  return context(fixture, "WAITER", employeeId, new Set(["promotions.view", "promotions.manage"]));
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Promo tenant", slug: `promo-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Promo Restaurant", currency: "RSD", timezone: "Europe/Belgrade" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "seed" } });
  const shift = await prisma.shift.findFirstOrThrow({ where: { locationId: location.id } });

  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Kokteli", slug: `kokteli-${randomUUID()}`, type: "DRINK" } });
  const otherCategory = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Pivo", slug: `pivo-${randomUUID()}`, type: "DRINK" } });
  const menuItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Mojito", slug: `mojito-${randomUUID()}`, price: "600.00", taxRate: "20", preparationStation: "BAR" },
  });

  return { restaurantId: restaurant.id, locationId: location.id, shiftId: shift.id, categoryId: category.id, otherCategoryId: otherCategory.id, menuItemId: menuItem.id };
}

async function newTable(fixture: Fixture) {
  return prisma.restaurantTable.create({ data: { floorId: (await prisma.floor.findFirstOrThrow({ where: { locationId: fixture.locationId } })).id, label: `T-${randomUUID().slice(0, 6)}` } });
}

async function openOrder(fixture: Fixture, ctx: AuthContext) {
  const table = await newTable(fixture);
  return orders.openOrder(ctx, { tableId: table.id });
}

/** Percentage Happy Hour: Mon-Fri 17:00-19:00, -20%, targeting the fixture's category. */
function happyHourInput(overrides: Partial<Parameters<typeof promotions.createPromotion>[1]> = {}) {
  return {
    name: "Happy Hour",
    isActive: true,
    type: "PERCENTAGE_DISCOUNT" as const,
    value: 20,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startTime: 0,
    endTime: 1439,
    priority: 0,
    targets: { menuItemIds: [], categoryIds: [] },
    ...overrides,
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("Promotion CRUD — authorization & audit", () => {
  it("WAITER cannot create a promotion (promotions.manage required)", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture, "WAITER", "w1", new Set()); // no promotions.manage
    await expect(promotions.createPromotion(ctx, happyHourInput({ targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("MANAGER can create, and it is recorded in AuditLog", async () => {
    const fixture = await createFixture();
    const ctx = managerCtx(fixture);
    const promo = await promotions.createPromotion(ctx, happyHourInput({ targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));
    expect(promo.name).toBe("Happy Hour");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Promotion", entityId: promo.id, action: "promotion.created" } });
    expect(audit.newValue).toMatchObject({ name: "Happy Hour", type: "PERCENTAGE_DISCOUNT" });
  });

  it("activate/deactivate are audited independently from edit", async () => {
    const fixture = await createFixture();
    const ctx = managerCtx(fixture);
    const promo = await promotions.createPromotion(ctx, happyHourInput({ isActive: false, targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    await promotions.activatePromotion(ctx, promo.id);
    await promotions.deactivatePromotion(ctx, promo.id);

    const activated = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Promotion", entityId: promo.id, action: "promotion.activated" } });
    const deactivated = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Promotion", entityId: promo.id, action: "promotion.deactivated" } });
    expect(activated).toBeTruthy();
    expect(deactivated).toBeTruthy();
  });

  it("rejects a target referencing a menu item from another restaurant", async () => {
    const fixture = await createFixture();
    const ctx = managerCtx(fixture);
    await expect(promotions.createPromotion(ctx, happyHourInput({ targets: { menuItemIds: [randomUUID()], categoryIds: [] } }))).rejects.toThrow(/nije pronađen/);
  });
});

describe("resolveEffectivePrice — core pricing math (Decimal, never float)", () => {
  const AT = new Date("2026-01-05T17:30:00.000Z"); // 18:30 Belgrade time, Monday

  it("PERCENTAGE_DISCOUNT: 600 -20% = 480.00 exactly", async () => {
    const fixture = await createFixture();
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ value: 20, targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const result = await resolveEffectivePrice({
      restaurantId: fixture.restaurantId, locationId: fixture.locationId,
      menuItemId: fixture.menuItemId, categoryId: fixture.categoryId,
      basePrice: "600.00", modifierDelta: "0", at: AT,
    });
    expect(result.regularPrice.toString()).toBe("600");
    expect(result.effectivePrice.toString()).toBe("480");
    expect(result.promotion?.name).toBe("Happy Hour");
  });

  it("FIXED_PRICE: promo price 450 replaces the base, modifiers still add on top", async () => {
    const fixture = await createFixture();
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ type: "FIXED_PRICE", value: 450, targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const result = await resolveEffectivePrice({
      restaurantId: fixture.restaurantId, locationId: fixture.locationId,
      menuItemId: fixture.menuItemId, categoryId: fixture.categoryId,
      basePrice: "600.00", modifierDelta: "50.00", at: AT,
    });
    expect(result.effectivePrice.toString()).toBe("500"); // 450 + 50 modifier
    expect(result.promotion?.type).toBe("FIXED_PRICE");
  });

  it("category target applies to every item in that category", async () => {
    const fixture = await createFixture();
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ targets: { menuItemIds: [], categoryIds: [fixture.categoryId] } }));

    const result = await resolveEffectivePrice({
      restaurantId: fixture.restaurantId, locationId: fixture.locationId,
      menuItemId: fixture.menuItemId, categoryId: fixture.categoryId,
      basePrice: "600.00", modifierDelta: "0", at: AT,
    });
    expect(result.effectivePrice.toString()).toBe("480");
  });

  it("no promotion targeting the item/category -> regular price, unaffected by an active but irrelevant promotion", async () => {
    const fixture = await createFixture();
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ targets: { menuItemIds: [], categoryIds: [fixture.otherCategoryId] } }));

    const result = await resolveEffectivePrice({
      restaurantId: fixture.restaurantId, locationId: fixture.locationId,
      menuItemId: fixture.menuItemId, categoryId: fixture.categoryId,
      basePrice: "600.00", modifierDelta: "0", at: AT,
    });
    expect(result.effectivePrice.toString()).toBe("600");
    expect(result.promotion).toBeNull();
  });

  it("inactive promotion (isActive=false) is never applied", async () => {
    const fixture = await createFixture();
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ isActive: false, targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const result = await resolveEffectivePrice({
      restaurantId: fixture.restaurantId, locationId: fixture.locationId,
      menuItemId: fixture.menuItemId, categoryId: fixture.categoryId,
      basePrice: "600.00", modifierDelta: "0", at: AT,
    });
    expect(result.promotion).toBeNull();
  });

  it("future promotion (startDate ahead) and expired promotion (endDate behind) are never applied", async () => {
    const fixture = await createFixture();
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ startDate: "2099-01-01", targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));
    await promotions.createPromotion(managerCtx(fixture, "mgr-2"), happyHourInput({ endDate: "2020-01-01", targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const result = await resolveEffectivePrice({
      restaurantId: fixture.restaurantId, locationId: fixture.locationId,
      menuItemId: fixture.menuItemId, categoryId: fixture.categoryId,
      basePrice: "600.00", modifierDelta: "0", at: AT,
    });
    expect(result.promotion).toBeNull();
  });

  it("outside the scheduled time window -> regular price (exact-boundary math itself is covered by promotion-schedule unit tests)", async () => {
    const fixture = await createFixture();
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ startTime: 17 * 60, endTime: 19 * 60, targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const outsideWindow = new Date("2026-01-05T09:00:00.000Z"); // 10:00 Belgrade — before 17:00
    const result = await resolveEffectivePrice({
      restaurantId: fixture.restaurantId, locationId: fixture.locationId,
      menuItemId: fixture.menuItemId, categoryId: fixture.categoryId,
      basePrice: "600.00", modifierDelta: "0", at: outsideWindow,
    });
    expect(result.promotion).toBeNull();
  });

  it("no stacking: two simultaneously-active promotions never combine — exactly one applies, item-level wins over category-level", async () => {
    const fixture = await createFixture();
    await promotions.createPromotion(managerCtx(fixture, "mgr-cat"), happyHourInput({ name: "Category promo", value: 10, targets: { menuItemIds: [], categoryIds: [fixture.categoryId] } }));
    await promotions.createPromotion(managerCtx(fixture, "mgr-item"), happyHourInput({ name: "Item promo", value: 20, targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const result = await resolveEffectivePrice({
      restaurantId: fixture.restaurantId, locationId: fixture.locationId,
      menuItemId: fixture.menuItemId, categoryId: fixture.categoryId,
      basePrice: "600.00", modifierDelta: "0", at: AT,
    });
    expect(result.promotion?.name).toBe("Item promo");
    expect(result.effectivePrice.toString()).toBe("480"); // -20%, NOT -30% (10+20 stacked)
  });

  it("a misconfigured promotion that would RAISE the price is never applied", async () => {
    const fixture = await createFixture();
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ type: "FIXED_PRICE", value: 900, targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const result = await resolveEffectivePrice({
      restaurantId: fixture.restaurantId, locationId: fixture.locationId,
      menuItemId: fixture.menuItemId, categoryId: fixture.categoryId,
      basePrice: "600.00", modifierDelta: "0", at: AT,
    });
    expect(result.promotion).toBeNull();
    expect(result.effectivePrice.toString()).toBe("600");
  });
});

describe("Order pricing pipeline — snapshot discipline (addItem + submitOrder)", () => {
  it("addItem freezes the promo price and full snapshot (regularPrice/promotionId/Name/Type/Value) onto OrderItem", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const order = await openOrder(fixture, ctx);
    const item = await orders.addItem(ctx, order.id, { menuItemId: fixture.menuItemId, quantity: 2, modifierOptionIds: [] });

    expect(item.price.toString()).toBe("480");
    expect(item.regularPrice?.toString()).toBe("600");
    expect(item.promotionName).toBe("Happy Hour");
    expect(item.promotionType).toBe("PERCENTAGE_DISCOUNT");
    expect(item.promotionValue?.toString()).toBe("20");
  });

  it("historical snapshot is preserved after the Promotion is later EDITED (name/value changed)", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const promo = await promotions.createPromotion(managerCtx(fixture), happyHourInput({ targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const order = await openOrder(fixture, ctx);
    const item = await orders.addItem(ctx, order.id, { menuItemId: fixture.menuItemId, quantity: 1, modifierOptionIds: [] });
    await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });

    await promotions.updatePromotion(managerCtx(fixture), promo.id, happyHourInput({ name: "Happy Hour RENAMED", value: 90, targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const unchanged = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.price.toString()).toBe("480"); // still -20%, never retroactively -90%
    expect(unchanged.promotionName).toBe("Happy Hour"); // snapshot, not the new name
    expect(unchanged.promotionValue?.toString()).toBe("20");
  });

  it("historical snapshot is preserved after the Promotion is DEACTIVATED", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const promo = await promotions.createPromotion(managerCtx(fixture), happyHourInput({ targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const order = await openOrder(fixture, ctx);
    const item = await orders.addItem(ctx, order.id, { menuItemId: fixture.menuItemId, quantity: 1, modifierOptionIds: [] });
    await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });

    await promotions.deactivatePromotion(managerCtx(fixture), promo.id);

    const unchanged = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.price.toString()).toBe("480");
  });

  it("historical snapshot is preserved after the MenuItem's base price changes", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const order = await openOrder(fixture, ctx);
    const item = await orders.addItem(ctx, order.id, { menuItemId: fixture.menuItemId, quantity: 1, modifierOptionIds: [] });
    await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });

    await prisma.menuItem.update({ where: { id: fixture.menuItemId }, data: { price: "1000.00" } });

    const unchanged = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.price.toString()).toBe("480");
    expect(unchanged.regularPrice?.toString()).toBe("600");
  });

  it("submitOrder re-evaluates the promotion at server-acceptance time — a promo that started AFTER addItem is correctly applied at submit", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);

    const order = await openOrder(fixture, ctx);
    const item = await orders.addItem(ctx, order.id, { menuItemId: fixture.menuItemId, quantity: 1, modifierOptionIds: [] });
    expect(item.price.toString()).toBe("600"); // no promo existed yet at add time

    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));
    const submitted = await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });

    const submittedItem = submitted.items.find((i) => i.id === item.id)!;
    expect(submittedItem.price.toString()).toBe("480"); // submit is authoritative, not add
    expect(submittedItem.promotionName).toBe("Happy Hour");
  });

  it("submitOrder correctly REMOVES a promo snapshot if the promotion was deactivated between addItem and submit", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const promo = await promotions.createPromotion(managerCtx(fixture), happyHourInput({ targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const order = await openOrder(fixture, ctx);
    const item = await orders.addItem(ctx, order.id, { menuItemId: fixture.menuItemId, quantity: 1, modifierOptionIds: [] });
    expect(item.price.toString()).toBe("480");

    await promotions.deactivatePromotion(managerCtx(fixture), promo.id);
    const submitted = await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });

    const submittedItem = submitted.items.find((i) => i.id === item.id)!;
    expect(submittedItem.price.toString()).toBe("600");
    expect(submittedItem.promotionId).toBeNull();
    expect(submittedItem.promotionName).toBeNull();
  });

  it("quantity increment across a promotion boundary: a submitted promo-priced line stays fixed; a NEW addItem after the promo ends creates its OWN separate, full-price line (never a quantity bump of the old row)", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const promo = await promotions.createPromotion(managerCtx(fixture), happyHourInput({ targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));

    const order = await openOrder(fixture, ctx);
    const firstUnit = await orders.addItem(ctx, order.id, { menuItemId: fixture.menuItemId, quantity: 1, modifierOptionIds: [] });
    await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() }); // committed at 480 — now SUBMITTED, quantity-locked

    await promotions.deactivatePromotion(managerCtx(fixture), promo.id); // Happy Hour "ends"

    // Waiter orders "another Mojito" — a genuinely new addItem, never a
    // quantity bump of the already-SUBMITTED row (order-service.ts's
    // updateItem guard already enforces this, unrelated to promotions).
    const secondUnit = await orders.addItem(ctx, order.id, { menuItemId: fixture.menuItemId, quantity: 1, modifierOptionIds: [] });

    expect(secondUnit.id).not.toBe(firstUnit.id);
    expect(secondUnit.price.toString()).toBe("600"); // full price — the promo had already ended

    const firstUnitAfter = await prisma.orderItem.findUniqueOrThrow({ where: { id: firstUnit.id } });
    expect(firstUnitAfter.price.toString()).toBe("480"); // untouched
    expect(firstUnitAfter.quantity).toBe(1); // never silently became 2
  });
});

describe("Downstream safety — Payment/Receipt/KDS/Inventory never re-derive price", () => {
  async function submittedOrderWithPromo(fixture: Fixture, ctx: AuthContext) {
    await promotions.createPromotion(managerCtx(fixture), happyHourInput({ targets: { menuItemIds: [fixture.menuItemId], categoryIds: [] } }));
    const order = await openOrder(fixture, ctx);
    const item = await orders.addItem(ctx, order.id, { menuItemId: fixture.menuItemId, quantity: 3, modifierOptionIds: [] });
    const submitted = await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });
    return { order: submitted, item };
  }

  it("Payment.amount and PaymentItem.unitPrice are computed from the frozen OrderItem.price (3 x 480 = 1440), never re-derived from MenuItem", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const managerPaymentCtx = context(fixture, "MANAGER", "mgr-pay", new Set(["orders.print"]));
    const { order } = await submittedOrderWithPromo(fixture, ctx);

    const { payment } = await billing.completePayment(managerPaymentCtx, order.id, { method: "CASH", tenderedAmount: 2000 });
    expect(payment.amount.toString()).toBe("1728"); // 1440 + 20% VAT (taxRate default 20)

    const paymentItem = await prisma.paymentItem.findFirstOrThrow({ where: { paymentId: payment.id } });
    expect(paymentItem.unitPrice.toString()).toBe("480");
    expect(paymentItem.lineTotal.toString()).toBe("1440");
  });

  it("Receipt line items snapshot the promo price — reprint remains identical even after the promotion is later deleted from Admin view (archived)", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const managerPaymentCtx = context(fixture, "MANAGER", "mgr-pay", new Set(["orders.print"]));
    const { order } = await submittedOrderWithPromo(fixture, ctx);
    const { payment } = await billing.completePayment(managerPaymentCtx, order.id, { method: "CASH", tenderedAmount: 2000 });

    const receipt = await prisma.receipt.findFirstOrThrow({ where: { paymentId: payment.id } });
    const items = receipt.items as Array<{ name: string; price: string; lineTotal: string }>;
    expect(items[0].price).toBe("480");
    expect(items[0].lineTotal).toBe("1440");
  });

  it("dispatches exactly one KDS PrintJob for the promo-priced line — no duplicate dispatch caused by pricing logic", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const { order } = await submittedOrderWithPromo(fixture, ctx);

    const printJobs = await prisma.printJob.findMany({ where: { orderId: order.id } });
    expect(printJobs).toHaveLength(1);
    expect(printJobs[0].station).toBe("BAR");
  });

  it("inventory/normativi deduction is quantity-based only — unaffected by which price was charged (DIRECT_STOCK)", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    await prisma.menuItem.update({ where: { id: fixture.menuItemId }, data: { inventoryTrackingMethod: "DIRECT_STOCK" } });
    await prisma.inventoryItem.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, menuItemId: fixture.menuItemId, currentStock: "100", unit: "kom" } });

    const managerPaymentCtx = context(fixture, "MANAGER", "mgr-pay", new Set(["orders.print"]));
    const { order } = await submittedOrderWithPromo(fixture, ctx); // quantity 3, price 480 (promo)
    await billing.completePayment(managerPaymentCtx, order.id, { method: "CASH", tenderedAmount: 2000 });

    const stock = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.menuItemId } });
    expect(stock.currentStock.toString()).toBe("97"); // 100 - 3, regardless of promo price
  });
});

describe("Server never trusts a client-supplied price", () => {
  it("addOrderItemSchema has no price field at all — a client cannot inject one", async () => {
    const { addOrderItemSchema } = await import("@rcs/shared");
    const parsed = addOrderItemSchema.parse({ menuItemId: randomUUID(), quantity: 1, modifierOptionIds: [], price: 1 } as never);
    expect((parsed as Record<string, unknown>).price).toBeUndefined();
  });
});
