import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { prisma, Prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { ingredients, recipes, inventory, inventura, orders, billing, promotions, printing, production, splitBilling, tableOwnership, transfers, voids } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";
import * as auditService from "../../packages/domain/audit/audit-service";

beforeEach(async () => { await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles"); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture() {
  const tenant = await prisma.tenant.create({ data: { name: "Inventory audit", slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Audit", timezone: "Europe/Belgrade" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "A" } });
  const employee = await prisma.employee.create({ data: { restaurantId: restaurant.id, firstName: "Owner", lastName: "Audit" } });
  const ctx: AuthContext = { restaurantId: restaurant.id, employeeId: employee.id, userId: employee.id, locationIds: [location.id], roles: ["OWNER"], permissions: new Set(["inventory.view", "inventory.manage", "inventory.opening_stock", "inventory.count", "menu.view", "menu.manage", "promotions.manage", "orders.print", "production.manage", "shifts.manage"]) };
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: employee.id } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Audit", slug: randomUUID(), type: "FOOD" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Audit" } });
  const item = await prisma.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Punjena pljeskavica", slug: randomUUID(), price: 600, preparationStation: "KITCHEN" } });
  const open = async () => {
    const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: randomUUID() } });
    return orders.openOrder(ctx, { tableId: table.id });
  };
  const ingredient = async (name: string, unit: "KILOGRAM" | "GRAM" | "LITER" = "KILOGRAM", quantity = 10) => {
    const ing = await ingredients.createIngredient(ctx, { name, unit });
    const stock = await ingredients.initializeStock(ctx, { ingredientId: ing.id, locationId: location.id, initialStock: quantity });
    return { ing, stock };
  };
  const pay = async (quantity = 1) => {
    const order = await open();
    await orders.addItem(ctx, order.id, { menuItemId: item.id, quantity, modifierOptionIds: [] });
    await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });
    return billing.completePayment(ctx, order.id, { method: "CASH" });
  };
  return { ctx, location, item, ingredient, open, pay, floor };
}

describe("Inventory audit regressions", () => {
  it("concurrent start/resume returns one open Inventura session", async () => {
    const f = await fixture();
    let unlock!: () => void; let locked!: () => void;
    const gate = new Promise<void>(r => { unlock = r; }); const ready = new Promise<void>(r => { locked = r; });
    const holder = prisma.$transaction(async tx => {
      // Let all competing reads finish while holding their INSERTs in the DB.
      await tx.$executeRaw`LOCK TABLE inventory_count_sessions IN SHARE MODE`;
      locked(); await gate;
    }, { timeout: 15000 });
    await ready;
    const starting = Promise.all(Array.from({ length: 3 }, () => inventura.startOrResumeSession(f.ctx, { locationId: f.location.id })));
    let sessions: Awaited<typeof starting>;
    try {
      for (let i = 0; i < 100; i++) {
        const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (Number(rows[0].n) >= 3) break;
        await new Promise(r => setTimeout(r, 20));
      }
    } finally { unlock(); await holder; sessions = await starting; }
    expect(new Set(sessions.map(s => s.id)).size).toBe(1);
    expect(await prisma.inventoryCountSession.count({ where: { status: "OPEN", locationId: f.location.id } })).toBe(1);
  });

  it("a count edit racing confirmation cannot change the confirmed physical quantity without its stock correction", async () => {
    const f = await fixture(); const { ing, stock } = await f.ingredient("Meso");
    const session = await inventura.startOrResumeSession(f.ctx, { locationId: f.location.id });
    const [lineId] = await inventura.addLines(f.ctx, session.id, { targets: [{ targetType: "INGREDIENT", ingredientId: ing.id }] });
    await inventura.enterPhysicalQuantity(f.ctx, session.id, lineId, 9.4);
    let unlock!: () => void; let locked!: () => void;
    const gate = new Promise<void>(r => { unlock = r; }); const ready = new Promise<void>(r => { locked = r; });
    const holder = prisma.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM inventory_count_sessions WHERE id = ${session.id} FOR UPDATE`; locked(); await gate; }, { timeout: 15000 });
    await ready;
    const confirmation = inventura.confirmSession(f.ctx, session.id, {});
    let editing: Promise<unknown> | undefined;
    try {
      for (let i = 0; i < 100; i++) {
        const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (Number(rows[0].n) > 0) break;
        await new Promise(r => setTimeout(r, 20));
      }
      editing = inventura.enterPhysicalQuantity(f.ctx, session.id, lineId, 9.7).catch(e => e);
      await Promise.race([editing, new Promise(r => setTimeout(r, 100))]);
    } finally { unlock(); await holder; await confirmation; await editing; }
    const line = await prisma.inventoryCountLine.findUniqueOrThrow({ where: { id: lineId } });
    const current = await prisma.ingredientStock.findUniqueOrThrow({ where: { id: stock.id } });
    expect(line.physicalQty?.equals(current.currentStock)).toBe(true);
  });

  for (const operation of ["add", "update", "remove"] as const) {
    it(`recipe ${operation} rolls back if its required audit cannot be recorded`, async () => {
      const f = await fixture(); const { ing } = await f.ingredient("Meso");
      const line = operation === "add" ? null : await recipes.addRecipeLine(f.ctx, f.item.id, { ingredientId: ing.id, quantity: 0.3 });
      vi.spyOn(auditService, "recordAuditEntry").mockRejectedValueOnce(new Error("audit unavailable"));
      const action = operation === "add" ? recipes.addRecipeLine(f.ctx, f.item.id, { ingredientId: ing.id, quantity: 0.3 })
        : operation === "update" ? recipes.updateRecipeLine(f.ctx, line!.id, { quantity: 0.5 }) : recipes.removeRecipeLine(f.ctx, line!.id);
      await expect(action).rejects.toThrow("audit unavailable");
      const rows = await recipes.getRecipe(f.ctx, f.item.id);
      expect(rows).toHaveLength(operation === "add" ? 0 : 1);
      if (line) expect(rows[0].quantity.equals("0.3")).toBe(true);
    });
  }

  it("cannot reinterpret an ingredient's existing stock, recipe and historical movements by changing its unit", async () => {
    const f = await fixture(); const { ing, stock } = await f.ingredient("Meso");
    await recipes.addRecipeLine(f.ctx, f.item.id, { ingredientId: ing.id, quantity: 300, unit: "GRAM" });
    await expect(ingredients.updateIngredient(f.ctx, ing.id, { unit: "GRAM" })).rejects.toThrow(/jedinic/i);
    expect((await prisma.ingredient.findUniqueOrThrow({ where: { id: ing.id } })).unit).toBe("KILOGRAM");
    expect((await prisma.ingredientStock.findUniqueOrThrow({ where: { id: stock.id } })).currentStock.equals(10)).toBe(true);
  });

  it("rejects a recipe quantity below canonical precision instead of storing a zero-consumption recipe", async () => {
    const f = await fixture(); const { ing } = await f.ingredient("Začin");
    await expect(recipes.addRecipeLine(f.ctx, f.item.id, { ingredientId: ing.id, quantity: 0.4, unit: "GRAM" })).rejects.toThrow(/preciz|decimal/i);
    expect(await prisma.menuItemIngredient.count()).toBe(0);
  });

  it("zero-all does not reactivate NO_TRACKING or rewrite its frozen ledger", async () => {
    const f = await fixture();
    const stock = await inventory.initializeTracking(f.ctx, { menuItemId: f.item.id, locationId: f.location.id, initialStock: 8 });
    await inventory.setInventoryTrackingMethod(f.ctx, f.item.id, "NO_TRACKING", { confirmSwitchAwayFromDirectStock: true });
    const before = await prisma.inventoryMovement.count();
    await inventory.bulkZeroOpeningStock(f.ctx, { locationId: f.location.id });
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: f.item.id } })).inventoryTrackingMethod).toBe("NO_TRACKING");
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } })).currentStock.equals(8)).toBe(true);
    expect(await prisma.inventoryMovement.count()).toBe(before);
  });

  for (const kind of ["ingredient", "direct", "direct-initialize", "direct-reactivate"] as const) {
    it(`${kind} opening-stock ledger uses the locked balance when a receipt is concurrently queued`, async () => {
      const f = await fixture();
      const raw = kind === "ingredient" ? await f.ingredient("Meso") : null;
      const stock = raw?.stock ?? await inventory.initializeTracking(f.ctx, { menuItemId: f.item.id, locationId: f.location.id, initialStock: 10 });
      if (kind === "direct-reactivate") await inventory.setInventoryTrackingMethod(f.ctx, f.item.id, "NO_TRACKING", { confirmSwitchAwayFromDirectStock: true });
      let unlock!: () => void; let locked!: () => void;
      const gate = new Promise<void>(r => { unlock = r; });
      const ready = new Promise<void>(r => { locked = r; });
      const holder = prisma.$transaction(async tx => {
        if (kind === "ingredient") await tx.$queryRaw`SELECT id FROM ingredient_stocks WHERE id = ${stock.id} FOR UPDATE`;
        else await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ${stock.id} FOR UPDATE`;
        locked(); await gate;
      }, { timeout: 15000 });
      const waitForLocks = async (count: number) => {
        for (let i = 0; i < 100; i++) {
          const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          if (Number(rows[0].n) >= count) return;
          await new Promise(r => setTimeout(r, 20));
        }
        throw new Error("Expected database lock queue was not reached");
      };
      await ready;
      let receive: Promise<unknown> | undefined; let opening: Promise<unknown> | undefined;
      try {
        receive = kind === "ingredient" ? ingredients.receiveStock(f.ctx, stock.id, { quantity: 2 }) : inventory.receiveStock(f.ctx, stock.id, { quantity: 2 });
        await waitForLocks(1);
        opening = kind === "direct-reactivate" ? inventory.setInventoryTrackingMethod(f.ctx, f.item.id, "DIRECT_STOCK", { confirmReactivateDirectStock: true }) : kind === "direct-initialize" ? inventory.initializeTracking(f.ctx, { menuItemId: f.item.id, locationId: f.location.id, initialStock: 5 }) : kind === "ingredient"
          ? ingredients.bulkSetIngredientOpeningStock(f.ctx, { locationId: f.location.id, lines: [{ ingredientId: raw!.ing.id, quantity: 5 }] })
          : inventory.bulkSetOpeningStock(f.ctx, { locationId: f.location.id, lines: [{ menuItemId: f.item.id, quantity: 5 }] });
        await waitForLocks(2);
      } finally { unlock(); await holder; await Promise.all([receive, opening]); }
      const movements = kind === "ingredient" ? await prisma.ingredientMovement.findMany({ where: { ingredientStockId: stock.id } }) : await prisma.inventoryMovement.findMany({ where: { inventoryItemId: stock.id } });
      const current = kind === "ingredient" ? await prisma.ingredientStock.findUniqueOrThrow({ where: { id: stock.id } }) : await prisma.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } });
      const sum = movements.reduce((n, row) => n.add(row.quantityDelta), new Prisma.Decimal(0));
      expect(sum.equals(current.currentStock)).toBe(true);
      expect(movements.find(m => m.type === (kind === "direct-reactivate" ? "ADJUSTMENT" : "OPENING_STOCK") && m.quantityAfter.equals(kind === "direct-reactivate" ? 0 : 5))?.quantityBefore.equals(12)).toBe(true);
    });
  }
});

describe("Inventory audit acceptance through real payments", () => {
  it("draft quantity edits/removal and supported submitted void deduct only the final sold quantity", async () => {
    const f = await fixture(); const { ing, stock } = await f.ingredient("Meso");
    await recipes.addRecipeLine(f.ctx, f.item.id, { ingredientId: ing.id, quantity: 300, unit: "GRAM" });
    const order = await f.open();
    const kept = await orders.addItem(f.ctx, order.id, { menuItemId: f.item.id, quantity: 1, modifierOptionIds: [] });
    await orders.updateItem(f.ctx, order.id, kept.id, { quantity: 2 });
    await orders.updateItem(f.ctx, order.id, kept.id, { quantity: 1 });
    const removed = await orders.addItem(f.ctx, order.id, { menuItemId: f.item.id, quantity: 1, note: "Remove draft", modifierOptionIds: [] });
    await orders.removeItem(f.ctx, order.id, removed.id);
    await orders.submitOrder(f.ctx, order.id, { idempotencyKey: randomUUID() });
    const second = await orders.addItem(f.ctx, order.id, { menuItemId: f.item.id, quantity: 2, modifierOptionIds: [] });
    await orders.submitOrder(f.ctx, order.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(f.ctx, order.id, second.id, { quantity: 1, reasonCode: "WRONG_QUANTITY", explanation: "Guest requested one serving, not two" });
    expect(await prisma.ingredientMovement.count({ where: { type: "SALE" } })).toBe(0);
    await billing.completePayment(f.ctx, order.id, { method: "CASH" });
    const sale = await prisma.ingredientMovement.findMany({ where: { type: "SALE", ingredientId: ing.id } });
    expect(sale).toHaveLength(1);
    expect(sale[0].quantityDelta.equals("-0.6")).toBe(true);
    expect((await prisma.ingredientStock.findUniqueOrThrow({ where: { id: stock.id } })).currentStock.equals("9.4")).toBe(true);
  });

  it("promotion, handover, partial transfer and a retried split payment affect price/ownership, never sold quantity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-01-05T17:30:00Z"));
    const f = await fixture(); const { ing } = await f.ingredient("Meso");
    await recipes.addRecipeLine(f.ctx, f.item.id, { ingredientId: ing.id, quantity: 300, unit: "GRAM" });
    await promotions.createPromotion(f.ctx, { name: "Happy Hour", type: "PERCENTAGE_DISCOUNT", value: 20, isActive: true, priority: 0, daysOfWeek: [0,1,2,3,4,5,6], startTime: 0, endTime: 1439, targets: { menuItemIds: [f.item.id], categoryIds: [] } });
    const order = await f.open(); const line = await orders.addItem(f.ctx, order.id, { menuItemId: f.item.id, quantity: 3, modifierOptionIds: [] });
    await orders.submitOrder(f.ctx, order.id, { idempotencyKey: randomUUID() });
    const incoming = await prisma.employee.create({ data: { restaurantId: f.ctx.restaurantId, firstName: "Incoming", lastName: "Waiter" } });
    await prisma.employeeLocation.create({ data: { employeeId: incoming.id, locationId: f.location.id } });
    const before = await prisma.ingredientMovement.findMany();
    const handed = await tableOwnership.transferTables(f.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId: order.id, expectedPreviousOwnerId: f.ctx.employeeId, newOwnerId: incoming.id }] });
    expect(handed.succeeded).toHaveLength(1);
    const target = await prisma.restaurantTable.create({ data: { floorId: f.floor.id, label: "Destination" } });
    await transfers.transferOrderItems(f.ctx, order.id, { destinationTableId: target.id, lines: [{ orderItemId: line.id, quantity: 1 }] });
    expect(await prisma.ingredientMovement.findMany()).toEqual(before);
    expect(await prisma.inventoryMovement.count()).toBe(0);
    const copied = await prisma.orderItem.findFirstOrThrow({ where: { menuItemId: f.item.id, orderId: { not: order.id } } });
    expect(copied.price.equals(480)).toBe(true); expect(copied.promotionName).toBe("Happy Hour"); expect(copied.regularPrice?.equals(600)).toBe(true);
    const input = { idempotencyKey: randomUUID(), method: "CASH" as const, lines: [{ orderItemId: line.id, quantity: 1 }] };
    const paid = await splitBilling.paySplitBill(f.ctx, order.id, input);
    const retry = await splitBilling.paySplitBill(f.ctx, order.id, input);
    expect(retry.payment.id).toBe(paid.payment.id);
    await splitBilling.paySplitBill(f.ctx, order.id, { ...input, idempotencyKey: randomUUID() });
    await billing.completePayment(f.ctx, copied.orderId, { method: "CASH" });
    const moves = await prisma.ingredientMovement.findMany({ where: { type: "SALE" } });
    expect(moves).toHaveLength(3);
    expect(moves.reduce((n,m)=>n.add(m.quantityDelta),new Prisma.Decimal(0)).equals("-0.9")).toBe(true);
  });

  it("reopens 300g/30g/30g, sells two rounds (2+1), and reprint/KDS/submit retries never deduct again", async () => {
    const f = await fixture();
    const values = [["Meso", 300], ["Kačkavalj", 30], ["Pršuta", 30]] as const;
    const ids: string[] = [];
    for (const [name, quantity] of values) {
      const { ing } = await f.ingredient(name, "GRAM", 10000); ids.push(ing.id);
      await recipes.addRecipeLine(f.ctx, f.item.id, { ingredientId: ing.id, quantity, unit: "GRAM" });
    }
    expect((await recipes.getRecipe(f.ctx, f.item.id)).map(l => l.quantity.toNumber())).toEqual([300, 30, 30]);
    const order = await f.open();
    const first = await orders.addItem(f.ctx, order.id, { menuItemId: f.item.id, quantity: 2, modifierOptionIds: [] });
    const key = randomUUID();
    await orders.submitOrder(f.ctx, order.id, { idempotencyKey: key });
    await orders.submitOrder(f.ctx, order.id, { idempotencyKey: key });
    for (const state of ["SUBMITTED", "ACCEPTED"] as const) await production.advanceItemStatus(f.ctx, order.id, first.id, "KITCHEN", state);
    await orders.addItem(f.ctx, order.id, { menuItemId: f.item.id, quantity: 1, modifierOptionIds: [] });
    await orders.submitOrder(f.ctx, order.id, { idempotencyKey: randomUUID() });
    expect(await prisma.ingredientMovement.count({ where: { type: "SALE" } })).toBe(0);
    await production.confirmPickup(f.ctx, order.id, first.id);
    await billing.completePayment(f.ctx, order.id, { method: "CASH" });
    await expect(billing.completePayment(f.ctx, order.id, { method: "CASH" })).rejects.toThrow();
    const ledger = await prisma.ingredientMovement.findMany({ where: { type: "SALE" }, orderBy: { ingredientId: "asc" } });
    for (let i = 0; i < ids.length; i++) expect(ledger.find(m => m.ingredientId === ids[i])?.quantityDelta.equals(-values[i][1] * 3)).toBe(true);
    for (let i = 0; i < 3; i++) await printing.reprintReceipt(f.ctx, order.id, randomUUID());
    expect(await prisma.ingredientMovement.findMany({ where: { type: "SALE" }, orderBy: { ingredientId: "asc" } })).toEqual(ledger);
  });

  it("25 separate 40ml sales from one litre end at exactly zero, including the first and third sale", async () => {
    const f = await fixture(); const { ing, stock } = await f.ingredient("Vinjak", "LITER", 1);
    await recipes.addRecipeLine(f.ctx, f.item.id, { ingredientId: ing.id, quantity: 40, unit: "MILLILITER" });
    for (let i = 1; i <= 25; i++) {
      await f.pay();
      const current = await prisma.ingredientStock.findUniqueOrThrow({ where: { id: stock.id } });
      expect(current.currentStock.equals(new Prisma.Decimal(1).sub(new Prisma.Decimal("0.04").mul(i)))).toBe(true);
    }
    expect(await prisma.ingredientMovement.count({ where: { type: "SALE", ingredientId: ing.id } })).toBe(25);
  });

  it("Inventura records exact -0.6kg shortage then +0.3kg surplus with audit and references", async () => {
    const f = await fixture(); const { ing, stock } = await f.ingredient("Meso");
    for (const target of [9.4, 9.7]) {
      const session = await inventura.startOrResumeSession(f.ctx, { locationId: f.location.id });
      const [id] = await inventura.addLines(f.ctx, session.id, { targets: [{ targetType: "INGREDIENT", ingredientId: ing.id }] });
      await inventura.enterPhysicalQuantity(f.ctx, session.id, id, target);
      await inventura.confirmSession(f.ctx, session.id, {});
      expect(await prisma.auditLog.count({ where: { entityId: session.id, action: "inventory_count.confirmed" } })).toBe(1);
    }
    const moves = await prisma.ingredientMovement.findMany({ where: { type: "INVENTORY_CORRECTION", ingredientId: ing.id }, orderBy: { createdAt: "asc" } });
    expect(moves.map(m => m.quantityDelta.toString())).toEqual(["-0.6", "0.3"]);
    expect(moves.every(m => m.employeeId === f.ctx.employeeId && m.referenceType === "INVENTORY_COUNT" && m.referenceId)).toBe(true);
    expect((await prisma.ingredientStock.findUniqueOrThrow({ where: { id: stock.id } })).currentStock.equals("9.7")).toBe(true);
  });
});
