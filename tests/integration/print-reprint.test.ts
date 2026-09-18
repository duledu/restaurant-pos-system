import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext, WorkstationAuthContext } from "@rcs/auth";
import { orders, billing, printing, workstations, agentPrinting } from "@rcs/domain";
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

// Owner context with management permissions (workstations.manage + settings.manage)
// for pairing/route configuration in the FIX #12/#13 Agent-delivery tests below.
function ownerContext(fixture: Fixture): AuthContext {
  return {
    userId: "owner-1",
    employeeId: "owner-1",
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["OWNER"],
    permissions: new Set(["orders.print", "workstations.manage", "settings.manage"]),
  };
}

// Pairs a computer with no preset station and stamps lastSeenAt — mirrors a
// live heartbeat so mode-aware eligibility (activeRouteTypes) treats it as
// the active Agent for the configured route types.
async function pairOnlineComputerForReceipt(fixture: Fixture) {
  const owner = ownerContext(fixture);
  const pairing = await workstations.createPairing(owner, { locationId: fixture.locationId, name: "ReceiptReprintAgent" });
  const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
  await workstations.upsertPrintRoute(owner, registered.workstationId, "RECEIPT", { printerName: "POS-58", paperWidthMm: 58 });
  await prisma.workstationPrintRoute.updateMany({
    where: { workstationId: registered.workstationId },
    data: { printerAvailable: true },
  });
  await prisma.workstation.update({ where: { id: registered.workstationId }, data: { lastSeenAt: new Date() } });
  const wsCtx: WorkstationAuthContext = {
    workstationId: registered.workstationId,
    restaurantId: registered.restaurantId,
    locationId: registered.locationId,
    station: registered.station,
  };
  return { wsCtx, owner };
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

// ── PHYSICAL QA FIX #12 (intentional reprint must print physically) +
// FIX #13 (UI wording reflects queued state) ─────────────────────────────
// These tests cover end-to-end agent delivery for both the AUTOMATIC
// payment-time dispatch AND every subsequent USER-INITIATED reprint.
// Pre-fix: `dispatchReceiptPrintJob` set `isAutomatic: !opts.isReprint`,
// making every user reprint invisible to `agentPrinting.pollAndClaim`
// (which filters `isAutomatic: true`) — the Physical-QA observed bug.
// Post-fix: receipt PrintJobs are Agent-claimable regardless of
// creation intent. `isReprint` keeps the audit/identity meaning.
describe("Physical-QA FIX #12/#13 — receipt dispatch through the Agent (incl. user reprints)", () => {
  it("automatic payment-time receipt is Agent-deliverable (existing behavior, regression-guard)", async () => {
    const fixture = await createFixture();
    const { wsCtx } = await pairOnlineComputerForReceipt(fixture);
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    // Pre-fix this used to assert (job.isAutomatic === true) implicitly
    // via dispatchReceiptPrintJob; post-fix we assert it explicitly so a
    // future refactor can't silently regress the automatic path.
    const autoJob = await prisma.printJob.findFirstOrThrow({
      where: { orderId: order.id, type: "RECEIPT", isReprint: false },
    });
    expect(autoJob.isAutomatic).toBe(true);
    expect(autoJob.dispatchKey).toBe(`receipt:${(await prisma.receipt.findFirstOrThrow({ where: { orderId: order.id } })).paymentId}`);

    // The same Agent that owns the RECEIPT route claims and prints it.
    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed).not.toBeNull();
    expect(claimed?.documentType).toBe("RECEIPT");
    expect(claimed?.jobId).toBe(autoJob.id);
    await agentPrinting.beginSubmission(wsCtx, claimed!.jobId, claimed!.attemptId);
    const result = await agentPrinting.submitResult(wsCtx, claimed!.jobId, claimed!.attemptId, "SUBMITTED_TO_SPOOLER");
    expect(result.status).toBe("PRINTED");
  });

  it("a USER-INITIATED reprint is Agent-deliverable (FIX #12 core regression test — would fail pre-fix)", async () => {
    const fixture = await createFixture();
    const { wsCtx } = await pairOnlineComputerForReceipt(fixture);
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    // Without first consuming the automatic receipt (which we deliberately
    // leave PENDING in the queue), the Agent's poll-and-claim would
    // otherwise grab the earlier automatic row. We exercise the reprint
    // path independently by completing the automatic row first.
    const autoJob = await prisma.printJob.findFirstOrThrow({
      where: { orderId: order.id, type: "RECEIPT", isReprint: false },
    });
    const autoClaim = (await agentPrinting.pollAndClaim(wsCtx))!;
    await agentPrinting.beginSubmission(wsCtx, autoClaim.jobId, autoClaim.attemptId);
    await agentPrinting.submitResult(wsCtx, autoClaim.jobId, autoClaim.attemptId, "SUBMITTED_TO_SPOOLER");
    await prisma.printJob.findUniqueOrThrow({ where: { id: autoJob.id } }); // sanity
    expect((await prisma.printJob.findUniqueOrThrow({ where: { id: autoJob.id } })).status).toBe("PRINTED");

    // Now the user clicks Reprint.
    const reprint = await printing.reprintReceipt(waiter, order.id, randomUUID());
    expect(reprint.isReprint).toBe(true);
    expect(reprint.type).toBe("RECEIPT");
    // FIX #12 — isAutomatic is the Agent-delivery-eligibility flag,
    // decoupled from creation intent. Reprints MUST be Agent-claimable.
    expect(reprint.isAutomatic).toBe(true);

    // The Agent's own poll loop (independent test of the same filter that
    // was hard-coded to `isAutomatic: true` previously and that hid every
    // reprint forever pre-fix) now picks the reprint up.
    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed).not.toBeNull();
    expect(claimed?.documentType).toBe("RECEIPT");
    expect(claimed?.jobId).toBe(reprint.id);
    expect(claimed?.isReprint).toBe(true);

    // Full lifecycle ends in PRINTED — exactly the same path KITCHEN/BAR
    // uses. No special-casing, no separate RECEIPT lifecycle invented.
    await agentPrinting.beginSubmission(wsCtx, claimed!.jobId, claimed!.attemptId);
    const result = await agentPrinting.submitResult(wsCtx, claimed!.jobId, claimed!.attemptId, "SUBMITTED_TO_SPOOLER");
    expect(result.status).toBe("PRINTED");
  });

  it("rapid double-click (server-side: same idempotencyKey replayed) returns the SAME PrintJob — exactly one physical print", async () => {
    const fixture = await createFixture();
    const { wsCtx } = await pairOnlineComputerForReceipt(fixture);
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    // Settle the automatic receipt so it doesn't shadow the replay test.
    const autoClaim = (await agentPrinting.pollAndClaim(wsCtx))!;
    await agentPrinting.beginSubmission(wsCtx, autoClaim.jobId, autoClaim.attemptId);
    await agentPrinting.submitResult(wsCtx, autoClaim.jobId, autoClaim.attemptId, "SUBMITTED_TO_SPOOLER");

    // Same idempotencyKey replayed twice — models the rapid double-click
    // window where the client-side in-flight promise pin (print-client.ts)
    // hands the SAME UUID to both fetches. Server's @@unique upsert must
    // collapse to a single row.
    const clickKey = randomUUID();
    const first = await printing.reprintReceipt(waiter, order.id, clickKey);
    const replay = await printing.reprintReceipt(waiter, order.id, clickKey);
    expect(replay.id).toBe(first.id);

    // Exactly one PENDING RECEIPT PrintJob (reprint) remains to be claimed.
    const pendingReprints = await prisma.printJob.findMany({
      where: { orderId: order.id, type: "RECEIPT", isReprint: true, status: "PENDING" },
    });
    expect(pendingReprints).toHaveLength(1);

    // Agent picks it up EXACTLY once. The second poll returns null — the
    // single physical paper contract.
    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed?.jobId).toBe(first.id);
    await agentPrinting.beginSubmission(wsCtx, claimed!.jobId, claimed!.attemptId);
    await agentPrinting.submitResult(wsCtx, claimed!.jobId, claimed!.attemptId, "SUBMITTED_TO_SPOOLER");
    expect(await agentPrinting.pollAndClaim(wsCtx)).toBeNull();
  });

  it("each NEW intentional reprint produces a fresh, separately-claimable PrintJob (2nd, 3rd reprints all physically print)", async () => {
    const fixture = await createFixture();
    const { wsCtx } = await pairOnlineComputerForReceipt(fixture);
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    // Settle the automatic receipt once.
    const autoClaim = (await agentPrinting.pollAndClaim(wsCtx))!;
    await agentPrinting.beginSubmission(wsCtx, autoClaim.jobId, autoClaim.attemptId);
    await agentPrinting.submitResult(wsCtx, autoClaim.jobId, autoClaim.attemptId, "SUBMITTED_TO_SPOOLER");

    // Three sequential intentional reprints, each a NEW user intent (the
    // client generates a fresh UUID per click after the previous response
    // resolves — see print-client.ts map cleanup in `finally`).
    const first = await printing.reprintReceipt(waiter, order.id, randomUUID());
    const second = await printing.reprintReceipt(waiter, order.id, randomUUID());
    const third = await printing.reprintReceipt(waiter, order.id, randomUUID());

    // All three distinct, none collapsed onto the automatic row.
    const ids = new Set([first.id, second.id, third.id]);
    expect(ids.size).toBe(3);
    expect(first.id).not.toBe(autoClaim.jobId);
    expect(second.id).not.toBe(first.id);
    expect(third.id).not.toBe(second.id);

    // Each is Agent-deliverable exactly once, in order. Drains the queue.
    for (const expected of [first, second, third]) {
      const claimed = (await agentPrinting.pollAndClaim(wsCtx))!;
      expect(claimed.jobId).toBe(expected.id);
      await agentPrinting.beginSubmission(wsCtx, claimed.jobId, claimed.attemptId);
      await agentPrinting.submitResult(wsCtx, claimed.jobId, claimed.attemptId, "SUBMITTED_TO_SPOOLER");
      const row = await prisma.printJob.findUniqueOrThrow({ where: { id: expected.id } });
      expect(row.status).toBe("PRINTED");
    }
    expect(await agentPrinting.pollAndClaim(wsCtx)).toBeNull();
  });

  it("reprint dispatchKey preserves receipt-reprint identity — cannot collapse onto the automatic receipt row", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, payment } = await payOrder(fixture, waiter);

    const autoJob = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "RECEIPT", isReprint: false } });
    const reprint = await printing.reprintReceipt(waiter, order.id, randomUUID());

    // The exact dispatchKey pattern documented at print-service.ts head:
    // automatic -> "receipt:<paymentId>", reprint -> "receipt-reprint:<paymentId>:<uuid>".
    expect(autoJob.dispatchKey).toBe(`receipt:${payment.id}`);
    expect(reprint.dispatchKey.startsWith(`receipt-reprint:${payment.id}:`)).toBe(true);
    expect(reprint.id).not.toBe(autoJob.id);
    // No row count crept above the expected 2 (1 automatic + 1 reprint).
    expect(await prisma.printJob.count({ where: { orderId: order.id, type: "RECEIPT" } })).toBe(2);
  });

  it("Agent-claimed reprint carries documentType='RECEIPT' and the same RAČUN route identity as the automatic row", async () => {
    const fixture = await createFixture();
    const { wsCtx } = await pairOnlineComputerForReceipt(fixture);
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    // Settle automatic.
    const autoClaim = (await agentPrinting.pollAndClaim(wsCtx))!;
    await agentPrinting.beginSubmission(wsCtx, autoClaim.jobId, autoClaim.attemptId);
    await agentPrinting.submitResult(wsCtx, autoClaim.jobId, autoClaim.attemptId, "SUBMITTED_TO_SPOOLER");

    const reprint = await printing.reprintReceipt(waiter, order.id, randomUUID());
    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed?.documentType).toBe("RECEIPT");
    expect(claimed?.jobId).toBe(reprint.id);
    // Same PrintJob.type — both rows belong to the same RAČUN route; the
    // Windows Print Agent looks up its local route by this type, so a
    // reprint routed to RAČUN has to use the SAME key as the automatic
    // receipt. (This is also the documented Agent contract in
    // agent-print-service.ts pollAndClaim.)
    expect(claimed?.documentType).toBe(reprint.type);
  });

  it("automatic receipt behavior (1 row per payment, idempotent printReceipt, no audit as reprint) is unchanged after the fix", async () => {
    // Regression guard for scenarios #1/#11 of the spec — same as the
    // pre-existing describe block above, but repeated here so a future
    // edit to dispatchReceiptPrintJob can't silently break the
    // automatic path while "fixing" reprints.
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order, payment, receipt } = await payOrder(fixture, waiter);

    const auto = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "RECEIPT", isReprint: false } });
    expect(auto.dispatchKey).toBe(`receipt:${payment.id}`);
    expect(auto.type).toBe("RECEIPT");
    expect(auto.isAutomatic).toBe(true);

    // printReceipt (the primary waiter action) is idempotent: second call
    // returns the SAME row, never a second physical print.
    const again = await printing.printReceipt(waiter, order.id);
    expect(again.id).toBe(auto.id);
    expect(await prisma.printJob.count({ where: { orderId: order.id, type: "RECEIPT", isReprint: false } })).toBe(1);

    // printReceipt must NEVER be audited as a reprint — only the
    // user-initiated reprintReceipt() is. (The audit log distinguishes
    // physical re-printing from the idempotent primary action.)
    const reprintAudit = await prisma.auditLog.findFirst({
      where: { entityId: receipt.id, action: "receipt.reprinted" },
    });
    expect(reprintAudit).toBeNull();
  });

  it("PrintJob claim/lease/idempotency safety stays intact across the fix (no new contention surface for reprints)", async () => {
    // Regression guard for scenario #12 of the spec. Reprints now go
    // through the same poll/claim flow as the automatic row, so they
    // must inherit the same single-claimant + attempt identity contract.
    const fixture = await createFixture();
    const { wsCtx } = await pairOnlineComputerForReceipt(fixture);
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { order } = await payOrder(fixture, waiter);

    // Settle automatic.
    const autoClaim = (await agentPrinting.pollAndClaim(wsCtx))!;
    await agentPrinting.beginSubmission(wsCtx, autoClaim.jobId, autoClaim.attemptId);
    await agentPrinting.submitResult(wsCtx, autoClaim.jobId, autoClaim.attemptId, "SUBMITTED_TO_SPOOLER");

    const reprint = await printing.reprintReceipt(waiter, order.id, randomUUID());

    // Two concurrent Agent polls must produce exactly one claimant.
    const [a, b] = await Promise.all([agentPrinting.pollAndClaim(wsCtx), agentPrinting.pollAndClaim(wsCtx)]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.jobId).toBe(reprint.id);
    expect(winners[0]!.attemptId).toMatch(/^[0-9a-f-]{36}$/i);

    // Honest attempt identity — a stale attemptId can't finalize.
    await expect(
      agentPrinting.submitResult(wsCtx, reprint.id, randomUUID(), "SUBMITTED_TO_SPOOLER")
    ).rejects.toThrow();

    // The valid attemptId finalizes exactly once.
    await agentPrinting.beginSubmission(wsCtx, winners[0]!.jobId, winners[0]!.attemptId);
    const first = await agentPrinting.submitResult(wsCtx, winners[0]!.jobId, winners[0]!.attemptId, "SUBMITTED_TO_SPOOLER");
    expect(first.status).toBe("PRINTED");
    // Replaying the SAME attemptId + outcome returns the same row without
    // mutating anything — confirms the existing idempotent-confirm guard.
    const replay = await agentPrinting.submitResult(wsCtx, winners[0]!.jobId, winners[0]!.attemptId, "SUBMITTED_TO_SPOOLER");
    expect(replay).toEqual(first);
  });
});
