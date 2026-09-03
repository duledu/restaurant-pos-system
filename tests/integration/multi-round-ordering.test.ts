/**
 * FAZA 9 — VIŠE-KRUŽNO NARUČIVANJE (multi-round ordering na istom stolu).
 *
 * Slanje porudžbine NIKAD ne znači "ova porudžbina više ne prima stavke" —
 * znači SAMO "trenutno neposlate (DRAFT) stavke su poslate". Konobar mora
 * moći da doda naredni krug (npr. 2 Omleta poslata, pa 10 minuta kasnije
 * 1 Biftek) bez dupliranja KDS tiketa/OrderItemStation redova za već poslate
 * stavke i bez ikakvog uticaja na plaćanje/split bill/transfer/void/zalihu.
 * Vidi packages/domain/orders/order-service.ts submitOrder/getOwnedOpenOrder.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, voids, transfers, billing, splitBilling, printing, availability, inventory } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  omletId: string; // 400.00, 20%, KITCHEN
  biftekId: string; // 1500.00, 20%, KITCHEN
  vinjakId: string; // 120.00, 20%, BAR, sa modifier grupom "Zapremina"
  vinjakDupliOptionId: string; // "Dupli", +60.00
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
  return context(fixture, "MANAGER", employeeId, [fixture.locationId], new Set(["production.manage", "audit.view"]));
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "MultiRound tenant", slug: `mr-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const omlet = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Omlet", slug: `omlet-${randomUUID()}`, price: "400.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const biftek = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Biftek", slug: `biftek-${randomUUID()}`, price: "1500.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const vinjak = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Vinjak", slug: `vinjak-${randomUUID()}`, price: "120.00", taxRate: "20", preparationStation: "BAR" },
  });
  const zapreminaGroup = await prisma.modifierGroup.create({
    data: { restaurantId: restaurant.id, name: "Zapremina", required: false, minSelect: 0, maxSelect: 1 },
  });
  const vinjakDupli = await prisma.modifierOption.create({ data: { modifierGroupId: zapreminaGroup.id, name: "Dupli", priceDelta: "60.00" } });
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: vinjak.id, modifierGroupId: zapreminaGroup.id } });

  return {
    restaurantId: restaurant.id,
    locationId: location.id,
    tableId: table.id,
    omletId: omlet.id,
    biftekId: biftek.id,
    vinjakId: vinjak.id,
    vinjakDupliOptionId: vinjakDupli.id,
  };
}

async function openAndSubmit(fixture: Fixture, waiter: AuthContext, menuItemId: string, quantity: number) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  const item = await orders.addItem(waiter, order.id, { menuItemId, quantity });
  const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
  return { order: submitted, firstItem: item };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("multi-round ordering: core acceptance scenario", () => {
  it("2 Omlets submit -> 10 minutes later add 1 Biftek -> submit -> only Biftek is new kitchen work", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");

    const { order: round1 } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);
    expect(round1.status).toBe("SUBMITTED");

    const biftek = await orders.addItem(waiter, round1.id, { menuItemId: fixture.biftekId, quantity: 1 });
    expect(biftek.status).toBe("DRAFT");

    const round2 = await orders.submitOrder(waiter, round1.id, { idempotencyKey: randomUUID() });
    const omletItem = round2.items.find((i) => i.menuItemId === fixture.omletId)!;
    const biftekItem = round2.items.find((i) => i.menuItemId === fixture.biftekId)!;
    expect(omletItem.status).toBe("SUBMITTED");
    expect(biftekItem.status).toBe("SUBMITTED");

    // Omlet keeps its ORIGINAL station row (round 1), Biftek gets exactly ONE new one (round 2).
    const omletStations = await prisma.orderItemStation.findMany({ where: { orderItemId: omletItem.id } });
    const biftekStations = await prisma.orderItemStation.findMany({ where: { orderItemId: biftekItem.id } });
    expect(omletStations).toHaveLength(1);
    expect(biftekStations).toHaveLength(1);

    // Round 2's KDS ticket contains ONLY Biftek, never Omlet again.
    const jobs = await prisma.printJob.findMany({ where: { orderId: round1.id, type: "KITCHEN" }, orderBy: { createdAt: "asc" } });
    expect(jobs).toHaveLength(2);
    const round1Content = jobs[0].content as { items: { name: string }[]; isAdditional: boolean };
    const round2Content = jobs[1].content as { items: { name: string }[]; isAdditional: boolean };
    expect(round2Content.items.map((i) => i.name)).toEqual(["Biftek"]);

    // First submission is never labeled "DODATNA PORUDŽBINA"; every later round always is.
    expect(round1Content.isAdditional).toBe(false);
    expect(round2Content.isAdditional).toBe(true);
  });
});

describe("multi-round ordering: submit semantics", () => {
  it("accepts a new DRAFT item after the order was already SUBMITTED", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);

    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });
    expect(item.status).toBe("DRAFT");

    const reloaded = await orders.getOrder(waiter, order.id);
    expect(reloaded.status).toBe("SUBMITTED");
    expect(reloaded.items).toHaveLength(2);
  });

  it("second submit leaves round-1 items completely untouched (status and submittedAt)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, firstItem } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);
    const round1Omlet = await prisma.orderItem.findUniqueOrThrow({ where: { id: firstItem.id } });

    await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const round2Omlet = await prisma.orderItem.findUniqueOrThrow({ where: { id: firstItem.id } });
    expect(round2Omlet.status).toBe("SUBMITTED");
    expect(round2Omlet.submittedAt?.getTime()).toBe(round1Omlet.submittedAt?.getTime());
  });

  it("increasing quantity of an already-submitted item is rejected; a repeat add creates a separate new DRAFT row instead", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, firstItem } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);

    await expect(orders.updateItem(waiter, order.id, firstItem.id, { quantity: 3 })).rejects.toThrow("Poništi");
    await expect(orders.removeItem(waiter, order.id, firstItem.id)).rejects.toThrow("Poništi");

    const secondOmlet = await orders.addItem(waiter, order.id, { menuItemId: fixture.omletId, quantity: 1 });
    expect(secondOmlet.id).not.toBe(firstItem.id);
    expect(secondOmlet.status).toBe("DRAFT");

    const omletRows = await prisma.orderItem.findMany({ where: { orderId: order.id, menuItemId: fixture.omletId } });
    expect(omletRows).toHaveLength(2);
  });

  it("retrying/re-invoking submit with nothing new drafted is a safe no-op (no duplicate print jobs or station rows)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);

    const before = await orders.getOrder(waiter, order.id);
    const stationRowsBefore = await prisma.orderItemStation.count({ where: { orderItem: { orderId: order.id } } });
    const printJobsBefore = await prisma.printJob.count({ where: { orderId: order.id } });

    const again = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    expect(again.status).toBe(before.status);

    expect(await prisma.orderItemStation.count({ where: { orderItem: { orderId: order.id } } })).toBe(stationRowsBefore);
    expect(await prisma.printJob.count({ where: { orderId: order.id } })).toBe(printJobsBefore);
  });

  it("table stays OCCUPIED across multiple rounds and no second order is created", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);
    await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("OCCUPIED");
    expect(await prisma.order.count({ where: { tableId: fixture.tableId } })).toBe(1);
  });
});

describe("multi-round ordering: RBAC/ownership across rounds", () => {
  it("any waiter with location access (not just the opener) can add and submit a new round", async () => {
    const fixture = await createFixture();
    const waiter1 = context(fixture, "WAITER", "waiter-1");
    const waiter2 = context(fixture, "WAITER", "waiter-2");
    const { order } = await openAndSubmit(fixture, waiter1, fixture.omletId, 2);

    await orders.addItem(waiter2, order.id, { menuItemId: fixture.biftekId, quantity: 1 });
    const round2 = await orders.submitOrder(waiter2, order.id, { idempotencyKey: randomUUID() });
    expect(round2.items.find((i) => i.menuItemId === fixture.biftekId)?.status).toBe("SUBMITTED");
  });

  it("a waiter without access to the order's location cannot add a new round", async () => {
    const fixture = await createFixture();
    const waiter1 = context(fixture, "WAITER", "waiter-1");
    const outsider = context(fixture, "WAITER", "waiter-3", []);
    const { order } = await openAndSubmit(fixture, waiter1, fixture.omletId, 2);

    await expect(orders.addItem(outsider, order.id, { menuItemId: fixture.biftekId, quantity: 1 })).rejects.toThrow();
  });
});

describe("multi-round ordering: payment / split bill coexistence", () => {
  it("completePayment is blocked while an unsent round exists, and succeeds once it is submitted", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);
    await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });

    await expect(billing.completePayment(waiter, order.id, { method: "CARD" })).rejects.toThrow("neposlate stavke");

    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    const { order: paidOrder } = await billing.completePayment(waiter, order.id, { method: "CARD" });
    expect(paidOrder.status).toBe("COMPLETED");
    const table = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: fixture.tableId } });
    expect(table.status).toBe("FREE");
  });

  it("split bill preview reports hasUnsentDraftItems and never reports fullyPaid until the new round is sent", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, firstItem } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);
    await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });

    const preview = await splitBilling.getSplitBillPreview(waiter, order.id);
    expect(preview.hasUnsentDraftItems).toBe(true);

    const payResult = await splitBilling.paySplitBill(waiter, order.id, {
      idempotencyKey: randomUUID(),
      method: "CARD",
      lines: [{ orderItemId: firstItem.id, quantity: 2 }],
    });
    // The Omlet line is fully covered, but the order can't be "final" while Biftek is still a draft.
    expect(payResult.isFinalPayment).toBe(false);
    expect(payResult.order.status).not.toBe("COMPLETED");

    const previewAfter = await splitBilling.getSplitBillPreview(waiter, order.id);
    expect(previewAfter.fullyPaid).toBe(false);
    expect(previewAfter.hasUnsentDraftItems).toBe(true);

    const round2 = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    const biftekItem = round2.items.find((i) => i.menuItemId === fixture.biftekId)!;
    const finalPay = await splitBilling.paySplitBill(waiter, order.id, {
      idempotencyKey: randomUUID(),
      method: "CARD",
      lines: [{ orderItemId: biftekItem.id, quantity: 1 }],
    });
    expect(finalPay.isFinalPayment).toBe(true);
    expect(finalPay.order.status).toBe("COMPLETED");
  });
});

describe("multi-round ordering: transfer / void coexistence", () => {
  it("transferring a round-1 item works while a round-2 draft item still sits unsent on the source order", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const destinationTable = await prisma.restaurantTable.create({
      data: { floorId: (await prisma.floor.findFirstOrThrow({ where: { locationId: fixture.locationId } })).id, label: "T2" },
    });
    const { order, firstItem } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);
    await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });

    const result = await transfers.transferOrderItems(waiter, order.id, {
      destinationTableId: destinationTable.id,
      lines: [{ orderItemId: firstItem.id, quantity: 2 }],
    });
    expect(result.transfers).toHaveLength(1);

    const source = await orders.getOrder(waiter, order.id);
    expect(source.items.find((i) => i.id === firstItem.id)).toBeUndefined();
    expect(source.items.find((i) => i.menuItemId === fixture.biftekId)?.status).toBe("DRAFT");
    expect(source.status).not.toBe("COMPLETED");
  });

  it("void works on an already-submitted item; remove is rejected for it but still works for a same-round draft item", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const { order, firstItem } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);
    const biftek = await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });

    const voided = await voids.voidOrderItem(manager, order.id, firstItem.id, {
      quantity: 1,
      reasonCode: "OTHER",
      explanation: "Correcting an entry mistake made 10 minutes ago before the second round.",
    });
    expect(voided.quantityAfter).toBe(1);

    await expect(orders.removeItem(waiter, order.id, firstItem.id)).rejects.toThrow("Poništi");
    await orders.removeItem(waiter, order.id, biftek.id);
    const reloaded = await orders.getOrder(waiter, order.id);
    expect(reloaded.items.find((i) => i.id === biftek.id)).toBeUndefined();
  });
});

describe("multi-round ordering: availability / inventory independence", () => {
  it("marking an item unavailable after round 1 blocks only the NEW round, never the already-submitted item", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = managerCtx(fixture);
    const { order, firstItem } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);

    await availability.setAvailability(manager, {
      locationId: fixture.locationId,
      menuItemId: fixture.omletId,
      isAvailable: false,
      reasonCode: "NEMA_PROIZVODA",
    });

    await expect(orders.addItem(waiter, order.id, { menuItemId: fixture.omletId, quantity: 1 })).rejects.toThrow("nedostupan");

    const untouched = await prisma.orderItem.findUniqueOrThrow({ where: { id: firstItem.id } });
    expect(untouched.status).toBe("SUBMITTED");
  });

  it("negative DIRECT_STOCK inventory never blocks adding or submitting a new round, and deduction still only happens at payment", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const owner = context(fixture, "OWNER", "owner-1", [fixture.locationId], new Set(["inventory.manage"]));
    const invItem = await inventory.initializeTracking(owner, { menuItemId: fixture.biftekId, locationId: fixture.locationId, initialStock: 2, unit: "kom" });
    await prisma.inventoryItem.update({ where: { id: invItem.id }, data: { currentStock: -3 } });

    const { order } = await openAndSubmit(fixture, waiter, fixture.omletId, 2);
    const biftek = await orders.addItem(waiter, order.id, { menuItemId: fixture.biftekId, quantity: 1 });
    expect(biftek.status).toBe("DRAFT");

    const round2 = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    expect(round2.items.find((i) => i.id === biftek.id)?.status).toBe("SUBMITTED");
    expect(await prisma.inventoryMovement.count({ where: { orderId: order.id } })).toBe(0);

    const stillNegative = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
    expect(Number(stillNegative.currentStock)).toBe(-3);
  });
});

describe("multi-round ordering: 'Dodaj još u porudžbinu' search/add regression (Vinjak bug)", () => {
  it("adding a NEW item with modifiers via a later round works, keeps its own modifiers, and never touches round-1 items", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, firstItem } = await openAndSubmit(fixture, waiter, fixture.omletId, 3);

    // Isti korak koji konobar radi posle "Pretraga menija..." → tap na
    // rezultat: addItem sa modifierOptionIds (klijent ovo radi kroz
    // ModifierSelectionModal, domenska putanja je identična).
    const vinjak = await orders.addItem(waiter, order.id, {
      menuItemId: fixture.vinjakId,
      quantity: 1,
      modifierOptionIds: [fixture.vinjakDupliOptionId],
    });
    expect(vinjak.status).toBe("DRAFT");

    const round2 = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    const vinjakSubmitted = round2.items.find((i) => i.id === vinjak.id)!;
    expect(vinjakSubmitted.status).toBe("SUBMITTED");
    expect(vinjakSubmitted.modifiers.map((m) => m.optionName)).toEqual(["Dupli"]);
    expect(Number(vinjakSubmitted.price)).toBe(180); // 120 + 60 (Dupli)

    // Round-1 Omlet potpuno netaknut.
    const omletStillThere = await prisma.orderItem.findUniqueOrThrow({ where: { id: firstItem.id } });
    expect(omletStillThere.quantity).toBe(3);
    expect(omletStillThere.status).toBe("SUBMITTED");

    // Vinjakov tiket sadrži SAMO Vinjak (BAR stanica), ne Omlet.
    const barJob = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "BAR" } });
    const barContent = barJob.content as { items: { name: string }[] };
    expect(barContent.items.map((i) => i.name)).toEqual(["Vinjak"]);
  });

  it("the literal reported scenario: 3 Omleti already submitted, waiter searches 'Vinjak' and adds it as the only new work", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await openAndSubmit(fixture, waiter, fixture.omletId, 3);

    // Klijentska pretraga ("Vinjak"/"vinjak"/"VINJAK") je čista funkcija
    // testirana odvojeno u tests/unit/menu-search.test.ts — ovde se
    // proverava da ISTI artikal koji bi pretraga pronašla stvarno može da
    // se doda i pošalje kroz punu domensku putanju, bez modifikatora.
    const vinjak = await orders.addItem(waiter, order.id, { menuItemId: fixture.vinjakId, quantity: 1 });
    expect(vinjak.status).toBe("DRAFT");

    const reloaded = await orders.getOrder(waiter, order.id);
    const draftItems = reloaded.items.filter((i) => i.status === "DRAFT");
    expect(draftItems).toHaveLength(1);
    expect(draftItems[0].name).toBe("Vinjak");

    const round2 = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    expect(round2.items.every((i) => i.menuItemId !== fixture.omletId || i.status === "SUBMITTED")).toBe(true);
    expect(round2.items.find((i) => i.id === vinjak.id)?.status).toBe("SUBMITTED");
  });
});
