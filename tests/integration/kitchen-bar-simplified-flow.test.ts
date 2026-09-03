/**
 * FAZA 10 — UPROŠĆEN KUHINJA/ŠANK TOK + SPREMNO OBAVEŠTENJE KONOBARU.
 *
 * Kuhinja/Šank: PRIHVATI -> SPREMNO direktno ("Počni pripremu"/PREPARING
 * korak uklonjen iz radnog toka, iako PREPARING i dalje postoji u enumu
 * radi unazadne kompatibilnosti — vidi production-service.ts NEXT_STATUS).
 * PREUZETO (READY -> SERVED) je sada ISKLJUČIVO konobarska radnja
 * (production-service.ts confirmPickup, requireOrderOperator), ne više
 * kuhinjska/šank akcija.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { orders, production, tables } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  biftekId: string; // KITCHEN
  pomfritId: string; // KITCHEN
  colaId: string; // BAR
  comboId: string; // KITCHEN_AND_BAR
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
  return context(fixture, "MANAGER", employeeId, new Set(["production.view", "production.manage"]));
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "KB-Faza10 tenant", slug: `kb10-${randomUUID()}` } });
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
  const combo = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Kombo", slug: `combo-${randomUUID()}`, price: "2000.00", taxRate: "20", preparationStation: "KITCHEN_AND_BAR" },
  });

  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, biftekId: biftek.id, pomfritId: pomfrit.id, colaId: cola.id, comboId: combo.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("Kitchen/Bar: PRIHVATI -> SPREMNO direktno (no 'Počni pripremu')", () => {
  it("1-4: a newly submitted item can be accepted and go straight to READY, with no PREPARING step required", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const accepted = await production.advanceItemStatus(manager, order.id, item.id, "KITCHEN", "SUBMITTED");
    expect(accepted.status).toBe("ACCEPTED");

    const ready = await production.advanceItemStatus(manager, order.id, item.id, "KITCHEN", "ACCEPTED");
    expect(ready.status).toBe("READY"); // NE "PREPARING"

    const reloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloaded.status).toBe("READY");
  });

  it("a station still sitting in PREPARING from before this change can still advance to READY (backward compatible, no data migration)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    // Simulira stavku koja je VEĆ bila u PREPARING pre deploy-a ove izmene.
    await prisma.orderItemStation.update({ where: { orderItemId_station: { orderItemId: item.id, station: "KITCHEN" } }, data: { status: "PREPARING" } });

    const ready = await production.advanceItemStatus(manager, order.id, item.id, "KITCHEN", "PREPARING");
    expect(ready.status).toBe("READY");
  });

  it("Kitchen/Bar can no longer self-advance READY -> SERVED — that action is rejected server-side", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await production.advanceItemStatus(manager, order.id, item.id, "KITCHEN", "SUBMITTED");
    await production.advanceItemStatus(manager, order.id, item.id, "KITCHEN", "ACCEPTED");

    await expect(production.advanceItemStatus(manager, order.id, item.id, "KITCHEN", "READY")).rejects.toThrow(
      "se ne može dalje pomeriti"
    );
  });

  it("13: Kitchen and Bar items behave correctly, and a KITCHEN_AND_BAR item only reaches the aggregate READY once BOTH stations are ready", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const combo = await orders.addItem(waiter, order.id, { menuItemId: fixture.comboId, quantity: 1 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await production.advanceItemStatus(manager, order.id, combo.id, "KITCHEN", "SUBMITTED");
    await production.advanceItemStatus(manager, order.id, combo.id, "KITCHEN", "ACCEPTED"); // kitchen -> READY
    let reloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: combo.id } });
    expect(reloaded.status).toBe("SUBMITTED"); // bar stanica jos nije ni prihvacena — agregat i dalje "najmanje napredna"

    await production.advanceItemStatus(manager, order.id, combo.id, "BAR", "SUBMITTED");
    await production.advanceItemStatus(manager, order.id, combo.id, "BAR", "ACCEPTED"); // bar -> READY
    reloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: combo.id } });
    expect(reloaded.status).toBe("READY"); // sada su OBE stanice READY
  });
});

describe("Waiter: SPREMNO notification + PREUZETO", () => {
  async function submitAndReady(fixture: Fixture, waiter: AuthContext, manager: AuthContext, menuItemId: string, station: "KITCHEN" | "BAR", quantity = 1) {
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId, quantity });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await production.advanceItemStatus(manager, submitted.id, item.id, station, "SUBMITTED");
    await production.advanceItemStatus(manager, submitted.id, item.id, station, "ACCEPTED");
    return { orderId: submitted.id, itemId: item.id };
  }

  it("5-6: listTables exposes the ready item on the correct table for the responsible waiter, with an accurate count", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    await submitAndReady(fixture, waiter, manager, fixture.biftekId, "KITCHEN");

    const floors = await tables.listTables(waiter, fixture.locationId);
    const table = floors.flatMap((f) => f.tables).find((t) => t.id === fixture.tableId)!;
    expect(table.activeOrderOwnerId).toBe(waiter.employeeId);
    expect(table.readyItems).toHaveLength(1);
    expect(table.readyItems[0].name).toBe("Biftek");
  });

  it("7: a DIFFERENT waiter (not the order opener) sees the same readyItems data — 'not notifying' is enforced client-side via activeOrderOwnerId, exactly like the existing 'Tvoj sto' pattern", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const otherWaiter = context(fixture, "WAITER", "waiter-2");
    const manager = managerCtx(fixture);
    await submitAndReady(fixture, waiter, manager, fixture.biftekId, "KITCHEN");

    const floors = await tables.listTables(otherWaiter, fixture.locationId);
    const table = floors.flatMap((f) => f.tables).find((t) => t.id === fixture.tableId)!;
    // Podaci su tu (isti kao za waiter-1) — ALI activeOrderOwnerId nije
    // waiter-2, pa klijent (pos-client.tsx) NE prikazuje bedž/puls/zvuk za
    // waiter-2. Vidi tests/unit/ready-notifications.test.ts za tu proveru.
    expect(table.activeOrderOwnerId).toBe(waiter.employeeId);
    expect(table.activeOrderOwnerId).not.toBe(otherWaiter.employeeId);
  });

  it("8: multiple ready items correctly increment the count", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const biftek = await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 2 });
    const pomfrit = await orders.addItem(waiter, order.id, { menuItemId: fixture.pomfritId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    for (const item of [biftek, pomfrit]) {
      await production.advanceItemStatus(manager, submitted.id, item.id, "KITCHEN", "SUBMITTED");
      await production.advanceItemStatus(manager, submitted.id, item.id, "KITCHEN", "ACCEPTED");
    }

    const floors = await tables.listTables(waiter, fixture.locationId);
    const table = floors.flatMap((f) => f.tables).find((t) => t.id === fixture.tableId)!;
    expect(table.readyItems).toHaveLength(2);
  });

  it("9-10: PREUZETO decrements the ready count, and the last PREUZETO clears the table alert entirely", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const biftek = await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });
    const pomfrit = await orders.addItem(waiter, order.id, { menuItemId: fixture.pomfritId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    for (const item of [biftek, pomfrit]) {
      await production.advanceItemStatus(manager, submitted.id, item.id, "KITCHEN", "SUBMITTED");
      await production.advanceItemStatus(manager, submitted.id, item.id, "KITCHEN", "ACCEPTED");
    }

    await production.confirmPickup(waiter, submitted.id, biftek.id);
    let floors = await tables.listTables(waiter, fixture.locationId);
    let table = floors.flatMap((f) => f.tables).find((t) => t.id === fixture.tableId)!;
    expect(table.readyItems).toHaveLength(1);
    expect(table.readyItems[0].id).toBe(pomfrit.id);

    await production.confirmPickup(waiter, submitted.id, pomfrit.id);
    floors = await tables.listTables(waiter, fixture.locationId);
    table = floors.flatMap((f) => f.tables).find((t) => t.id === fixture.tableId)!;
    expect(table.readyItems).toHaveLength(0);
  });

  it("11: confirming pickup does NOT close the order or free the table — it stays active until normal payment/closing", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const { orderId, itemId } = await submitAndReady(fixture, waiter, manager, fixture.biftekId, "KITCHEN");

    await production.confirmPickup(waiter, orderId, itemId);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).not.toBe("COMPLETED");
    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("OCCUPIED");
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.status).toBe("SERVED");
  });

  it("12: a new (unsent) round can still be added and submitted after an earlier round's item was picked up", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const { orderId, itemId } = await submitAndReady(fixture, waiter, manager, fixture.biftekId, "KITCHEN");
    await production.confirmPickup(waiter, orderId, itemId);

    const pomfrit = await orders.addItem(waiter, orderId, { menuItemId: fixture.pomfritId, quantity: 1 });
    expect(pomfrit.status).toBe("DRAFT");
    const round2 = await orders.submitOrder(waiter, orderId, { idempotencyKey: randomUUID() });
    expect(round2.items.find((i) => i.id === pomfrit.id)?.status).toBe("SUBMITTED");
  });

  it("only the order operator (WAITER/management) can confirm pickup — a KITCHEN role is rejected (that responsibility moved off the KDS)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const kitchenCtx = context(fixture, "KITCHEN", "kitchen-1", new Set(["production.view", "production.manage"]));
    const { orderId, itemId } = await submitAndReady(fixture, waiter, manager, fixture.biftekId, "KITCHEN");

    await expect(production.confirmPickup(kitchenCtx, orderId, itemId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("confirmPickup rejects an item that is not (yet, or no longer) READY", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    await expect(production.confirmPickup(waiter, submitted.id, item.id)).rejects.toThrow("nije (više) spremna");
  });

  it("only one of two concurrent pickup confirmations on the same item commits", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const { orderId, itemId } = await submitAndReady(fixture, waiter, manager, fixture.biftekId, "KITCHEN");

    const results = await Promise.allSettled([
      production.confirmPickup(waiter, orderId, itemId),
      production.confirmPickup(waiter, orderId, itemId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("records an order_item.picked_up event for audit/history", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const { orderId, itemId } = await submitAndReady(fixture, waiter, manager, fixture.biftekId, "KITCHEN");

    await production.confirmPickup(waiter, orderId, itemId);

    const event = await prisma.orderEvent.findFirstOrThrow({ where: { orderId, type: "order_item.picked_up" } });
    expect((event.payload as { itemId: string }).itemId).toBe(itemId);
  });
});
