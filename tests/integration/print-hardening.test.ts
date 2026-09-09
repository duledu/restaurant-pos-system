import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, printing, settings, voids, billing } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

let ctx: AuthContext;
let locationId: string;
let otherLocationId: string;
let floorId: string;
let kitchenId: string;
let barId: string;
beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
  const tenant = await prisma.tenant.create({ data: { name: "Printing safety", slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "A", currency: "RSD" } });
  const other = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "B" } });
  locationId = (await prisma.location.create({ data: { restaurantId: restaurant.id, name: "A" } })).id;
  otherLocationId = (await prisma.location.create({ data: { restaurantId: other.id, name: "B" } })).id;
  floorId = (await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId, name: "Floor" } })).id;
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId, openedBy: "manager" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Food", slug: randomUUID(), type: "FOOD" } });
  const item = (station: "KITCHEN" | "BAR") => prisma.menuItem.create({ data: {
    restaurantId: restaurant.id, categoryId: category.id, name: station, slug: randomUUID(), price: 100, taxRate: 20, preparationStation: station,
  } });
  kitchenId = (await item("KITCHEN")).id;
  barId = (await item("BAR")).id;
  ctx = { userId: "manager", employeeId: "manager", restaurantId: restaurant.id, locationIds: [locationId], roles: ["MANAGER"],
    permissions: new Set(["settings.manage", "orders.print", "production.manage", "production.view"]) };
});
async function policy(station: "KITCHEN" | "BAR", autoPrint: boolean, isEnabled = true) {
  return settings.upsertPrinterConfig(ctx, { locationId, station, name: station, paperWidthMm: 58, autoPrint, isEnabled });
}
async function send() {
  const table = await prisma.restaurantTable.create({ data: { floorId, label: "T" + randomUUID() } });
  const order = await orders.openOrder(ctx, { tableId: table.id });
  await orders.addItem(ctx, order.id, { menuItemId: kitchenId, quantity: 1 });
  await orders.addItem(ctx, order.id, { menuItemId: barId, quantity: 1 });
  await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });
  return order;
}
async function kitchenJob() {
  const order = await send();
  return prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, station: "KITCHEN" } });
}
async function ageClaim(id: string, started = false) {
  await prisma.printJob.update({ where: { id }, data: started
    ? { submissionStartedAt: new Date(Date.now() - 91_000) }
    : { claimedAt: new Date(Date.now() - 91_000) } });
}
const poll = () => printing.listPendingStationPrintJobs(ctx, locationId, "KITCHEN");

describe("printer configuration isolation", () => {
  it("allows valid own-location Kitchen/Bar settings and strips forged tenant fields", async () => {
    const result = await settings.upsertPrinterConfig(ctx, { locationId, station: "KITCHEN", name: "POS", paperWidthMm: 58,
      autoPrint: true, ...({ restaurantId: "forged" } as object) });
    expect(result.restaurantId).toBe(ctx.restaurantId);
    expect((await policy("BAR", false)).autoPrint).toBe(false);
  });
  it("rejects another tenant even with forged location membership and cannot overwrite its config", async () => {
    const owner = await prisma.location.findUniqueOrThrow({ where: { id: otherLocationId } });
    const original = await prisma.printerConfig.create({ data: { restaurantId: owner.restaurantId, locationId: otherLocationId, station: "KITCHEN", name: "Untouched" } });
    await expect(settings.upsertPrinterConfig({ ...ctx, locationIds: [otherLocationId] }, {
      locationId: otherLocationId, station: "KITCHEN", name: "Bad",
    })).rejects.toThrow();
    expect((await prisma.printerConfig.findUniqueOrThrow({ where: { id: original.id } })).name).toBe("Untouched");
    await settings.deletePrinterConfig(ctx, original.id);
    expect(await prisma.printerConfig.findUnique({ where: { id: original.id } })).not.toBeNull();
  });
  it("rejects nonexistent, inaccessible, and null/global locations", async () => {
    const missing = randomUUID();
    await expect(settings.upsertPrinterConfig({ ...ctx, locationIds: [missing] }, { locationId: missing, station: "BAR", name: "No" })).rejects.toThrow();
    await expect(settings.upsertPrinterConfig({ ...ctx, locationIds: [] }, { locationId, station: "BAR", name: "No" })).rejects.toThrow();
    await expect(settings.upsertPrinterConfig(ctx, { locationId: null as never, station: "BAR", name: "No" })).rejects.toThrow();
  });
  it("requires permission for upsert and delete", async () => {
    const saved = await policy("KITCHEN", true);
    const denied = { ...ctx, permissions: new Set<string>() };
    await expect(settings.upsertPrinterConfig(denied, { locationId, station: "KITCHEN", name: "No" })).rejects.toThrow();
    await expect(settings.deletePrinterConfig(denied, saved.id)).rejects.toThrow();
  });
  it("deletion retains a disabled policy and never restores implicit ON", async () => {
    const config = await policy("KITCHEN", true);
    const job = await kitchenJob();
    await settings.deletePrinterConfig(ctx, config.id);
    expect((await prisma.printerConfig.findUniqueOrThrow({ where: { id: config.id } })).isEnabled).toBe(false);
    expect((await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SUPPRESSED");
  });
});

describe("attempt ownership and reconciliation", () => {
  it("has one concurrent claimant and a strong attempt identity", async () => {
    const job = await kitchenJob();
    const claims = await Promise.all(Array.from({ length: 5 }, () => printing.beginPrintAttempt(ctx, job.orderId, job.id)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)!.attemptId).toMatch(/^[a-f0-9-]{36}$/);
    expect(claims.find(Boolean)!.attemptCount).toBe(1);
  });
  it.each(["TRANSPORT_COMPLETED", "SUBMITTED_TO_SPOOLER", "FAILED_BEFORE_SUBMISSION", "SUBMISSION_UNKNOWN"] as const)("confirms %s once; duplicate result does not mutate history/counters", async (outcome) => {
    const job = await kitchenJob();
    const claim = (await printing.beginPrintAttempt(ctx, job.orderId, job.id))!;
    if (outcome !== "FAILED_BEFORE_SUBMISSION") await printing.startPrintSubmission(ctx, job.orderId, job.id, claim.attemptId!);
    const result = { attemptId: claim.attemptId!, outcome };
    const first = await printing.confirmPrintResult(ctx, job.orderId, job.id, result);
    const again = await printing.confirmPrintResult(ctx, job.orderId, job.id, result);
    expect(again).toEqual(first);
    expect(again.attemptCount).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: job.id, action: "print.result" } })).toBe(1);
    await expect(printing.confirmPrintResult(ctx, job.orderId, job.id, { attemptId: claim.attemptId!,
      outcome: outcome === "SUBMITTED_TO_SPOOLER" ? "FAILED_BEFORE_SUBMISSION" : "SUBMITTED_TO_SPOOLER" })).rejects.toThrow();
  });
  it.each(["SUBMITTED_TO_SPOOLER", "FAILED_BEFORE_SUBMISSION"] as const)("old result cannot overwrite newer %s", async (outcome) => {
    const job = await kitchenJob();
    const old = (await printing.beginPrintAttempt(ctx, job.orderId, job.id))!;
    await ageClaim(job.id);
    await poll();
    const next = (await printing.beginPrintAttempt(ctx, job.orderId, job.id))!;
    expect(next.attemptId).not.toBe(old.attemptId);
    if (outcome === "SUBMITTED_TO_SPOOLER") await printing.startPrintSubmission(ctx, job.orderId, job.id, next.attemptId!);
    const done = await printing.confirmPrintResult(ctx, job.orderId, job.id, { attemptId: next.attemptId!, outcome });
    for (const staleOutcome of ["SUBMITTED_TO_SPOOLER", "FAILED_BEFORE_SUBMISSION"] as const)
      await expect(printing.confirmPrintResult(ctx, job.orderId, job.id, { attemptId: old.attemptId!, outcome: staleOutcome })).rejects.toThrow("Stale");
    expect(await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(done);
    expect(done.attemptCount).toBe(2);
  });
  it("rejects starts after claim expiry and rejects repeated start permission", async () => {
    const job = await kitchenJob();
    let claim = (await printing.beginPrintAttempt(ctx, job.orderId, job.id))!;
    await ageClaim(job.id);
    await expect(printing.startPrintSubmission(ctx, job.orderId, job.id, claim.attemptId!)).rejects.toThrow();
    await poll();
    claim = (await printing.beginPrintAttempt(ctx, job.orderId, job.id))!;
    await printing.startPrintSubmission(ctx, job.orderId, job.id, claim.attemptId!);
    await expect(printing.startPrintSubmission(ctx, job.orderId, job.id, claim.attemptId!)).rejects.toThrow();
    await ageClaim(job.id, true);
    await poll();
    expect((await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SUBMISSION_UNKNOWN");
    expect(await printing.beginPrintAttempt(ctx, job.orderId, job.id)).toBeNull();
    await expect(printing.retryPrintJob(ctx, job.orderId, job.id)).rejects.toThrow();
    // Late definitive acknowledgement of this same attempt reconciles the timeout.
    await printing.confirmPrintResult(ctx, job.orderId, job.id, { attemptId: claim.attemptId!, outcome: "SUBMITTED_TO_SPOOLER" });
    await poll();
    expect(await printing.beginPrintAttempt(ctx, job.orderId, job.id)).toBeNull();
  });
  it("requires start before success, blocks foreign tenant/station/employee attempts", async () => {
    const job = await kitchenJob();
    const claim = (await printing.beginPrintAttempt(ctx, job.orderId, job.id))!;
    await expect(printing.confirmPrintResult(ctx, job.orderId, job.id, { attemptId: claim.attemptId!, outcome: "SUBMITTED_TO_SPOOLER" })).rejects.toThrow();
    await expect(printing.startPrintSubmission(ctx, job.orderId, job.id, undefined as never)).rejects.toThrow();
    const wrong = { ...ctx, restaurantId: randomUUID() };
    await expect(printing.beginPrintAttempt(wrong, job.orderId, job.id)).rejects.toThrow();
    await expect(printing.confirmPrintResult(wrong, job.orderId, job.id, { attemptId: claim.attemptId!, outcome: "FAILED_BEFORE_SUBMISSION" })).rejects.toThrow();
    await expect(printing.startPrintSubmission({ ...ctx, employeeId: "other" }, job.orderId, job.id, claim.attemptId!)).rejects.toThrow();
    await expect(printing.beginPrintAttempt({ ...ctx, roles: ["BAR"] }, job.orderId, job.id)).rejects.toThrow();
  });
});

describe("automatic printing policy", () => {
  it("receipt printing remains independent of order auto OFF and safely recovers an unstarted receipt claim", async () => {
    await policy("KITCHEN", false);
    await policy("BAR", false);
    await settings.upsertPrinterConfig(ctx, { locationId, station: "RECEIPT", name: "Receipt", isEnabled: true, autoPrint: false });
    const order = await send();
    await billing.completePayment(ctx, order.id, { method: "CASH", tenderedAmount: 1000 });
    const job = await printing.reprintReceipt(ctx, order.id, randomUUID());
    expect(job.isAutomatic).toBe(false);
    const old = (await printing.beginPrintAttempt(ctx, order.id, job.id))!;
    await ageClaim(job.id);
    const next = (await printing.beginPrintAttempt(ctx, order.id, job.id))!;
    expect(next.attemptId).not.toBe(old.attemptId);
    await expect(printing.startPrintSubmission(ctx, order.id, job.id, old.attemptId!)).rejects.toThrow();
    await printing.startPrintSubmission(ctx, order.id, job.id, next.attemptId!);
    expect((await printing.confirmPrintResult(ctx, order.id, job.id, { attemptId: next.attemptId!, outcome: "TRANSPORT_COMPLETED" })).status).toBe("PRINTED");
    expect(await prisma.printJob.count({ where: { orderId: order.id, isAutomatic: true } })).toBe(0);
  });
  it.each(["KITCHEN", "BAR"] as const)("%s OFF creates no jobs and does not affect routing or additional rounds", async (station) => {
    await policy(station, false);
    const order = await send();
    expect(await prisma.printJob.count({ where: { orderId: order.id, station } })).toBe(0);
    expect(await prisma.orderItemStation.count({ where: { orderItem: { orderId: order.id }, station } })).toBe(1);
    await orders.addItem(ctx, order.id, { menuItemId: station === "KITCHEN" ? kitchenId : barId, quantity: 2 });
    await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });
    expect(await prisma.printJob.count({ where: { orderId: order.id, station } })).toBe(0);
    expect(await prisma.orderItemStation.count({ where: { orderItem: { orderId: order.id }, station } })).toBe(2);
    const manual = await printing.requestStationPrint(ctx, order.id, station, randomUUID());
    expect(manual.isAutomatic).toBe(false);
    expect(await printing.beginPrintAttempt(ctx, order.id, manual.id)).not.toBeNull();
    await policy(station, true);
    await printing.dispatchStationPrintJobs(ctx, order.id); // Must not reconstruct suppressed historical events.
    expect(await prisma.printJob.count({ where: { orderId: order.id, station, isAutomatic: true } })).toBe(0);
    const fresh = await send();
    expect(await prisma.printJob.count({ where: { orderId: fresh.id, station, isAutomatic: true } })).toBe(1);
  });
  it("OFF suppresses pending and pre-submission claims, never resurrects them", async () => {
    const pending = await kitchenJob();
    const active = await kitchenJob();
    const claim = (await printing.beginPrintAttempt(ctx, active.orderId, active.id))!;
    await policy("KITCHEN", false);
    for (const job of [pending, active]) expect((await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SUPPRESSED");
    await expect(printing.startPrintSubmission(ctx, active.orderId, active.id, claim.attemptId!)).rejects.toThrow();
    await policy("KITCHEN", true);
    expect(await printing.beginPrintAttempt(ctx, pending.orderId, pending.id)).toBeNull();
    expect(await printing.beginPrintAttempt(ctx, active.orderId, active.id)).toBeNull();
  });
  it("OFF preserves started/printed/failed history; manual retry/reprint remains independent", async () => {
    const started = await kitchenJob();
    const claim = (await printing.beginPrintAttempt(ctx, started.orderId, started.id))!;
    await printing.startPrintSubmission(ctx, started.orderId, started.id, claim.attemptId!);
    const failed = await kitchenJob();
    const failedClaim = (await printing.beginPrintAttempt(ctx, failed.orderId, failed.id))!;
    await printing.confirmPrintResult(ctx, failed.orderId, failed.id, { attemptId: failedClaim.attemptId!, outcome: "FAILED_BEFORE_SUBMISSION" });
    await policy("KITCHEN", false);
    expect((await prisma.printJob.findUniqueOrThrow({ where: { id: started.id } })).status).toBe("PRINTING");
    await printing.confirmPrintResult(ctx, started.orderId, started.id, { attemptId: claim.attemptId!, outcome: "SUBMITTED_TO_SPOOLER" });
    const key = randomUUID();
    const reprint = await printing.requestStationPrint(ctx, started.orderId, "KITCHEN", key, started.id);
    expect(reprint.content).toEqual(started.content);
    expect(reprint.reprintOfId).toBe(started.id);
    expect((await printing.requestStationPrint(ctx, started.orderId, "KITCHEN", key, started.id)).id).toBe(reprint.id);
    expect(await printing.beginPrintAttempt(ctx, reprint.orderId, reprint.id)).not.toBeNull();
    const retry = await printing.retryPrintJob(ctx, failed.orderId, failed.id);
    expect(retry.isAutomatic).toBe(false);
    expect(await printing.beginPrintAttempt(ctx, retry.orderId, retry.id)).not.toBeNull();
  });
  it("master disable blocks claims without disabling routing", async () => {
    await policy("KITCHEN", true, false);
    const order = await send();
    expect(await prisma.orderItemStation.count({ where: { orderItem: { orderId: order.id }, station: "KITCHEN" } })).toBe(1);
    await expect(printing.requestStationPrint(ctx, order.id, "KITCHEN", randomUUID())).rejects.toThrow();
  });
  it("OFF suppresses automatic cancellation events too", async () => {
    const order = await send();
    await policy("KITCHEN", false);
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id, menuItemId: kitchenId } });
    await voids.voidOrderItem(ctx, order.id, item.id, { quantity: 1, reasonCode: "WRONG_ITEM", explanation: "Printing policy cancellation test" });
    expect(await prisma.printJob.count({ where: { orderId: order.id, dispatchKey: { startsWith: "void:" }, station: "KITCHEN" } })).toBe(0);
  });
  it("concurrent policy OFF and dispatch/claim cannot leave printable automatic work", async () => {
    const job = await kitchenJob();
    await Promise.all([policy("KITCHEN", false), printing.dispatchStationPrintJobs(ctx, job.orderId), printing.beginPrintAttempt(ctx, job.orderId, job.id)]);
    expect((await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SUPPRESSED");
  });
});
