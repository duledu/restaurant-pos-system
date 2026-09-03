/**
 * FAZA 8 — TRANSFER STAVKI IZMEĐU STOLOVA.
 * Vidi packages/domain/orders/transfer-service.ts za arhitekturu.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError, type AuthContext } from "@rcs/auth";
import { orders, voids, billing, splitBilling, transfers, production, inventory, ingredients, recipes } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  sourceTableId: string;
  destinationTableId: string;
  otherLocationTableId: string;
  otherRestaurantTableId: string;
  biftekId: string; // 1200.00, 20%, KITCHEN
  colaId: string; // 300.00, 20%, BAR
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
  const tenant = await prisma.tenant.create({ data: { name: "Transfer tenant", slug: `transfer-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Other" } });
  const otherRestaurantLocation = await prisma.location.create({ data: { restaurantId: otherRestaurant.id, name: "Main" } });

  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const otherFloor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, name: "Floor" } });
  const otherRestaurantFloor = await prisma.floor.create({ data: { restaurantId: otherRestaurant.id, locationId: otherRestaurantLocation.id, name: "Floor" } });

  const sourceTable = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T4" } });
  const destinationTable = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T7" } });
  const otherLocationTable = await prisma.restaurantTable.create({ data: { floorId: otherFloor.id, label: "T-Other" } });
  const otherRestaurantTable = await prisma.restaurantTable.create({ data: { floorId: otherRestaurantFloor.id, label: "T-Foreign" } });

  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: otherLocation.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const biftek = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Biftek", slug: `biftek-${randomUUID()}`, price: "1200.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const cola = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Coca-Cola", slug: `cola-${randomUUID()}`, price: "300.00", taxRate: "20", preparationStation: "BAR" },
  });

  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    sourceTableId: sourceTable.id,
    destinationTableId: destinationTable.id,
    otherLocationTableId: otherLocationTable.id,
    otherRestaurantTableId: otherRestaurantTable.id,
    biftekId: biftek.id,
    colaId: cola.id,
  };
}

async function openSubmit(
  waiter: AuthContext,
  tableId: string,
  lines: { menuItemId: string; quantity: number; modifierOptionIds?: string[] }[]
) {
  const order = await orders.openOrder(waiter, { tableId });
  for (const line of lines) {
    await orders.addItem(waiter, order.id, { menuItemId: line.menuItemId, quantity: line.quantity, modifierOptionIds: line.modifierOptionIds ?? [] });
  }
  return orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
}

const EXPLANATION = "Confirmed with manager before voiding.";

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("transfer: whole item", () => {
  it("transfers one whole item to a table with no active order — creates a new SUBMITTED order there, preserving the item id", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.biftekId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const item = detail.items[0];

    const result = await transfers.transferOrderItems(waiter, submitted.id, {
      destinationTableId: fixture.destinationTableId,
      lines: [{ orderItemId: item.id, quantity: 1 }],
    });

    const destOrder = await prisma.order.findUniqueOrThrow({ where: { id: result.destinationOrderId } });
    expect(destOrder.status).toBe("SUBMITTED");
    expect(destOrder.tableId).toBe(fixture.destinationTableId);

    const destItems = await prisma.orderItem.findMany({ where: { orderId: destOrder.id } });
    expect(destItems).toHaveLength(1);
    expect(destItems[0].id).toBe(item.id); // ceo red — isti id, samo re-pointovan orderId

    const destTable = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.destinationTableId } });
    expect(destTable.status).toBe("OCCUPIED");

    // Izvorna porudžbina nema više nijednu živu stavku i nikad nije imala
    // Payment — auto-zatvorena kao CANCELLED, sto oslobođen.
    const sourceOrder = await prisma.order.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(sourceOrder.status).toBe("CANCELLED");
    const sourceTable = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.sourceTableId } });
    expect(sourceTable.status).toBe("FREE");
  });

  it("transfers multiple items in one call", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [
      { menuItemId: fixture.biftekId, quantity: 1 },
      { menuItemId: fixture.colaId, quantity: 1 },
    ]);
    const detail = await orders.getOrder(waiter, submitted.id);

    const result = await transfers.transferOrderItems(waiter, submitted.id, {
      destinationTableId: fixture.destinationTableId,
      lines: detail.items.map((i) => ({ orderItemId: i.id, quantity: 1 })),
    });

    const destItems = await prisma.orderItem.findMany({ where: { orderId: result.destinationOrderId } });
    expect(destItems).toHaveLength(2);
    expect(result.transfers).toHaveLength(2);
  });
});

describe("transfer: partial quantity", () => {
  it("transfers a partial quantity, leaving the remainder on the source order under the same item id", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.colaId, quantity: 3 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const item = detail.items[0];

    const result = await transfers.transferOrderItems(waiter, submitted.id, {
      destinationTableId: fixture.destinationTableId,
      lines: [{ orderItemId: item.id, quantity: 1 }],
    });

    const sourceItemReloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(sourceItemReloaded.quantity).toBe(2);
    expect(sourceItemReloaded.orderId).toBe(submitted.id); // ostaje na izvornoj porudžbini

    const destItems = await prisma.orderItem.findMany({ where: { orderId: result.destinationOrderId } });
    expect(destItems).toHaveLength(1);
    expect(destItems[0].id).not.toBe(item.id); // NOV red na odredištu
    expect(destItems[0].quantity).toBe(1);
  });

  it("only the unpaid remainder can be transferred — an already-paid quantity cannot", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.colaId, quantity: 2 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const item = detail.items[0];

    await splitBilling.paySplitBill(waiter, submitted.id, { idempotencyKey: randomUUID(), method: "CARD", lines: [{ orderItemId: item.id, quantity: 1 }] });

    await expect(
      transfers.transferOrderItems(waiter, submitted.id, { destinationTableId: fixture.destinationTableId, lines: [{ orderItemId: item.id, quantity: 2 }] })
    ).rejects.toThrow("neplaćenog ostatka");

    const result = await transfers.transferOrderItems(waiter, submitted.id, {
      destinationTableId: fixture.destinationTableId,
      lines: [{ orderItemId: item.id, quantity: 1 }],
    });

    const sourceItemReloaded = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(sourceItemReloaded.quantity).toBe(1); // ostaje SAMO plaćena jedinica
    expect(sourceItemReloaded.paidQuantity).toBe(1);

    const destItems = await prisma.orderItem.findMany({ where: { orderId: result.destinationOrderId } });
    expect(destItems[0].quantity).toBe(1);
    expect(destItems[0].paidQuantity).toBe(0);
  });
});

describe("transfer: modifiers & price snapshot", () => {
  it("preserves modifier selections and the price snapshot on the transferred item", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const group = await prisma.modifierGroup.create({ data: { restaurantId: fixture.restaurantId, name: "Dodaci", required: false, minSelect: 0, maxSelect: 3 } });
    const option = await prisma.modifierOption.create({ data: { modifierGroupId: group.id, name: "Extra sir", priceDelta: "100" } });
    await prisma.menuItemModifierGroup.create({ data: { menuItemId: fixture.biftekId, modifierGroupId: group.id } });

    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.biftekId, quantity: 2, modifierOptionIds: [option.id] }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const item = detail.items[0];
    expect(item.price.toString()).toBe("1300");

    const result = await transfers.transferOrderItems(waiter, submitted.id, {
      destinationTableId: fixture.destinationTableId,
      lines: [{ orderItemId: item.id, quantity: 1 }],
    });

    const destItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: result.destinationOrderId } });
    expect(destItem.price.toString()).toBe("1300"); // cena snapshot ostaje
    expect(destItem.taxRate.toString()).toBe("20");

    const destModifiers = await prisma.orderItemModifier.findMany({ where: { orderItemId: destItem.id } });
    expect(destModifiers).toHaveLength(1);
    expect(destModifiers[0].optionName).toBe("Extra sir");
    expect(destModifiers[0].priceDelta.toString()).toBe("100");
  });
});

describe("transfer: KDS state preserved", () => {
  it("copies KDS station status (not a fresh SUBMITTED request) onto a partially-transferred item", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const kitchen = context(fixture, "KITCHEN", "kitchen-1", [fixture.locationId], new Set(["production.view", "production.manage"]));
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.biftekId, quantity: 2 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const item = detail.items[0];

    await production.advanceItemStatus(kitchen, submitted.id, item.id, "KITCHEN", "SUBMITTED");
    await production.advanceItemStatus(kitchen, submitted.id, item.id, "KITCHEN", "ACCEPTED");

    const result = await transfers.transferOrderItems(waiter, submitted.id, {
      destinationTableId: fixture.destinationTableId,
      lines: [{ orderItemId: item.id, quantity: 1 }],
    });

    const sourceStation = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.id } });
    expect(sourceStation.status).toBe("READY"); // nepromenjeno transferom

    const destItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: result.destinationOrderId } });
    const destStation = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: destItem.id } });
    expect(destStation.status).toBe("READY"); // KOPIRANO stanje, ne novi SUBMITTED zahtev
    expect(destItem.status).toBe("READY");
  });

  it("preserves KDS history exactly via a whole-item move (same OrderItemStation row, same orderItemId)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const kitchen = context(fixture, "KITCHEN", "kitchen-1", [fixture.locationId], new Set(["production.view", "production.manage"]));
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.biftekId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const item = detail.items[0];

    await production.advanceItemStatus(kitchen, submitted.id, item.id, "KITCHEN", "SUBMITTED");
    const stationBefore = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.id } });

    await transfers.transferOrderItems(waiter, submitted.id, {
      destinationTableId: fixture.destinationTableId,
      lines: [{ orderItemId: item.id, quantity: 1 }],
    });

    const stationAfter = await prisma.orderItemStation.findFirstOrThrow({ where: { orderItemId: item.id } });
    expect(stationAfter.id).toBe(stationBefore.id); // ISTI red, nikad obrisan/dupliran
    expect(stationAfter.status).toBe("ACCEPTED");
    expect(await prisma.orderItemStation.count({ where: { orderItemId: item.id } })).toBe(1);
  });
});

describe("transfer: no inventory / ingredient side effects", () => {
  it("does not create any InventoryMovement or IngredientMovement and does not change stock", async () => {
    const fixture = await createFixture();
    const owner = managerCtx(fixture, "owner-1");
    const waiter = context(fixture, "WAITER", "waiter-1");
    await inventory.initializeTracking(owner, { menuItemId: fixture.colaId, locationId: fixture.locationId, initialStock: 10 });
    const meat = await ingredients.createIngredient(owner, { name: "Meso", unit: "KILOGRAM" });
    await ingredients.initializeStock(owner, { ingredientId: meat.id, locationId: fixture.locationId, initialStock: 10 });
    await recipes.addRecipeLine(owner, fixture.biftekId, { ingredientId: meat.id, quantity: 0.3 });

    const submitted = await openSubmit(waiter, fixture.sourceTableId, [
      { menuItemId: fixture.colaId, quantity: 2 },
      { menuItemId: fixture.biftekId, quantity: 1 },
    ]);
    const detail = await orders.getOrder(waiter, submitted.id);

    await transfers.transferOrderItems(waiter, submitted.id, {
      destinationTableId: fixture.destinationTableId,
      lines: detail.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    });

    expect(await prisma.inventoryMovement.count({ where: { orderId: submitted.id } })).toBe(0);
    expect(await prisma.ingredientMovement.count({ where: { orderId: submitted.id } })).toBe(0);

    const invItem = await prisma.inventoryItem.findFirstOrThrow({ where: { menuItemId: fixture.colaId, locationId: fixture.locationId } });
    expect(invItem.currentStock.toString()).toBe("10"); // netaknuto
    const stock = await prisma.ingredientStock.findFirstOrThrow({ where: { ingredientId: meat.id, locationId: fixture.locationId } });
    expect(stock.currentStock.toString()).toBe("10"); // netaknuto
  });
});

describe("transfer: ownership / RBAC", () => {
  it("allows a different WAITER (not the order opener) to transfer items from an already-submitted order", async () => {
    const fixture = await createFixture();
    const waiter1 = context(fixture, "WAITER", "waiter-1");
    const waiter2 = context(fixture, "WAITER", "waiter-2");
    const submitted = await openSubmit(waiter1, fixture.sourceTableId, [{ menuItemId: fixture.colaId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter1, submitted.id);

    await expect(
      transfers.transferOrderItems(waiter2, submitted.id, { destinationTableId: fixture.destinationTableId, lines: [{ orderItemId: detail.items[0].id, quantity: 1 }] })
    ).resolves.toBeTruthy();
  });

  it("rejects a KITCHEN role (neither WAITER nor management) from transferring items", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const kitchen = context(fixture, "KITCHEN", "kitchen-1", [fixture.locationId], new Set(["production.view"]));
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.colaId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);

    await expect(
      transfers.transferOrderItems(kitchen, submitted.id, { destinationTableId: fixture.destinationTableId, lines: [{ orderItemId: detail.items[0].id, quantity: 1 }] })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects transferring from a DRAFT (never-submitted) order", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.sourceTableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.colaId, quantity: 1 });

    await expect(
      transfers.transferOrderItems(waiter, order.id, { destinationTableId: fixture.destinationTableId, lines: [{ orderItemId: item.id, quantity: 1 }] })
    ).rejects.toThrow("Nacrt");
  });
});

describe("transfer: location / tenant safety", () => {
  it("rejects a cross-location transfer", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1", [fixture.locationId, fixture.otherLocationId]);
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.colaId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);

    await expect(
      transfers.transferOrderItems(waiter, submitted.id, { destinationTableId: fixture.otherLocationTableId, lines: [{ orderItemId: detail.items[0].id, quantity: 1 }] })
    ).rejects.toThrow("iste lokacije");
  });

  it("rejects a cross-restaurant transfer (foreign table is simply not found)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.colaId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);

    await expect(
      transfers.transferOrderItems(waiter, submitted.id, { destinationTableId: fixture.otherRestaurantTableId, lines: [{ orderItemId: detail.items[0].id, quantity: 1 }] })
    ).rejects.toThrow("nije pronađen");
  });

  it("rejects transferring into a destination table whose active order is still a DRAFT", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await orders.openOrder(waiter, { tableId: fixture.destinationTableId }); // ostaje DRAFT
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.colaId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);

    await expect(
      transfers.transferOrderItems(waiter, submitted.id, { destinationTableId: fixture.destinationTableId, lines: [{ orderItemId: detail.items[0].id, quantity: 1 }] })
    ).rejects.toThrow("nacrt");
  });
});

describe("transfer: concurrency", () => {
  it("allows only one of two concurrent transfers that both claim the full remaining quantity to commit", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const thirdTable = await prisma.restaurantTable.create({
      data: { floorId: (await prisma.floor.findFirstOrThrow({ where: { locationId: fixture.locationId } })).id, label: "T9" },
    });
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.colaId, quantity: 2 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const item = detail.items[0];

    const results = await Promise.allSettled([
      transfers.transferOrderItems(waiter, submitted.id, { destinationTableId: fixture.destinationTableId, lines: [{ orderItemId: item.id, quantity: 2 }] }),
      transfers.transferOrderItems(waiter, submitted.id, { destinationTableId: thirdTable.id, lines: [{ orderItemId: item.id, quantity: 2 }] }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("a concurrent void and transfer on the same item resolve safely — exactly one applies", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.colaId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const item = detail.items[0];

    const results = await Promise.allSettled([
      transfers.transferOrderItems(waiter, submitted.id, { destinationTableId: fixture.destinationTableId, lines: [{ orderItemId: item.id, quantity: 1 }] }),
      voids.voidOrderItem(manager, submitted.id, item.id, { quantity: 1, reasonCode: "OTHER", explanation: EXPLANATION }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("transfer: audit", () => {
  it("records an OrderItemTransfer row and an audit entry with actor/source/destination/item/quantity/timestamp", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await openSubmit(waiter, fixture.sourceTableId, [{ menuItemId: fixture.colaId, quantity: 1 }]);
    const detail = await orders.getOrder(waiter, submitted.id);
    const item = detail.items[0];

    const result = await transfers.transferOrderItems(waiter, submitted.id, {
      destinationTableId: fixture.destinationTableId,
      lines: [{ orderItemId: item.id, quantity: 1 }],
    });

    const transferRow = await prisma.orderItemTransfer.findFirstOrThrow({ where: { sourceOrderItemId: item.id } });
    expect(transferRow.transferredBy).toBe("waiter-1");
    expect(transferRow.transferredByRole).toBe("WAITER");
    expect(transferRow.sourceOrderId).toBe(submitted.id);
    expect(transferRow.destinationOrderId).toBe(result.destinationOrderId);
    expect(transferRow.sourceTableLabel).toBe("T4");
    expect(transferRow.destinationTableLabel).toBe("T7");
    expect(transferRow.quantity).toBe(1);
    expect(transferRow.transferredAt).toBeInstanceOf(Date);

    const auditEntry = await prisma.auditLog.findFirstOrThrow({ where: { entityId: item.id, action: "order_item.transferred" } });
    expect(auditEntry.userId).toBe("waiter-1");
    expect((auditEntry.newValue as { tableLabel: string }).tableLabel).toBe("T7");
  });
});
