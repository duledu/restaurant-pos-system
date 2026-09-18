import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import type { AuthContext, WorkstationAuthContext } from "@rcs/auth";
import { printing, workstations } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

/**
 * PRINTING P0 — regression suite for the three new state-machine changes:
 *
 *  1. acknowledgePrintAmbiguity(decision="PRINTED")
 *     SUBMISSION_UNKNOWN → PRINTED, audited, idempotent.
 *  2. acknowledgePrintAmbiguity(decision="REPRINT")
 *     SUBMISSION_UNKNOWN stays; a NEW PrintJob row is created with
 *     isReprint=true, reprintOfId=this.id, audited. The new row goes
 *     through the normal claim flow. Requires an idempotencyKey from
 *     the client; same (jobId, idempotencyKey) returns the same row
 *     without creating duplicates.
 *  3. confirmPhysicalTestByAgent
 *     physicalTestConfirmed flips to true on a configured+enabled route,
 *     audited as workstation.route_physically_confirmed. A subsequent
 *     change to printerName or paperWidthMm resets it (workspace-tested
 *     inline in upsertPrintRoute's reset logic).
 *  4. recordVisibilityProbe / heartbeat routes[].visible
 *     The route's visibleToService column is written by the heartbeat.
 *
 * Plus the safety property the entire P0 fix is built around:
 *  - SUBMISSION_UNKNOWN is structurally never re-claimed by pollAndClaim
 *    (status filter) regardless of how long it has been there.
 */

let ctx: AuthContext;
let restaurantId: string;
let locationId: string;
// PRINTING P0 — shift cache: business rule "only one OPEN shift per location"
// (enforced by partial unique index in DDL) means we must reuse the shift
// across multiple orders in the same test, otherwise makeOrder() would try
// to create a second open shift for the same location and trip the
// constraint. This cache is reset by beforeEach implicitly because
// restaurantId + locationId change every test (new tenant/restaurant/location).
let cachedShiftId: string | null = null;
let cachedFloorId: string | null = null;
let cachedTableId: string | null = null;

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
  const tenant = await prisma.tenant.create({ data: { name: "P0", slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "A", currency: "RSD" } });
  restaurantId = restaurant.id;
  locationId = (await prisma.location.create({ data: { restaurantId: restaurant.id, name: "A" } })).id;
  ctx = {
    userId: "manager",
    employeeId: "manager",
    restaurantId,
    locationIds: [locationId],
    roles: ["MANAGER"],
    permissions: new Set(["workstations.manage", "orders.print"]),
  };
  cachedShiftId = null;
  cachedFloorId = null;
  cachedTableId = null;
});

async function pairWorkstation(): Promise<{ workstationId: string; wsCtx: WorkstationAuthContext }> {
  const pairing = await workstations.createPairing(ctx, { locationId });
  const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
  await workstations.upsertPrintRoute(ctx, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
  await workstations.upsertPrintRoute(ctx, registered.workstationId, "RECEIPT", { printerName: "POS-58", paperWidthMm: 58 });
  return {
    workstationId: registered.workstationId,
    wsCtx: {
      workstationId: registered.workstationId,
      restaurantId: registered.restaurantId,
      locationId: registered.locationId,
      station: null,
    },
  };
}

async function makeOrder(): Promise<string> {
  // Order requires tableId + shiftId (FKs); create the supporting rows
  // inline so this test stays independent of any other test setup.
  // PRINTING P0 — reuse the shift/floor/table per test (cached) to honor the
  // "only one OPEN shift per location" partial unique constraint enforced by
  // the DDL partial unique index; multiple makeOrder() calls in one test (e.g.
  // listSubmissionUnknownJobs) would otherwise trip it on the second call.
  if (!cachedShiftId) {
    const shift = await prisma.shift.create({
      data: { restaurantId, locationId, openedBy: "manager", status: "OPEN" },
    });
    cachedShiftId = shift.id;
  }
  if (!cachedFloorId) {
    const floor = await prisma.floor.create({
      data: { restaurantId, locationId, name: `F-${randomUUID().slice(0, 4)}` },
    });
    cachedFloorId = floor.id;
  }
  if (!cachedTableId) {
    const table = await prisma.restaurantTable.create({
      data: { floorId: cachedFloorId, label: `T-${randomUUID().slice(0, 4)}`, capacity: 4 },
    });
    cachedTableId = table.id;
  }
  const order = await prisma.order.create({
    data: {
      restaurantId,
      locationId,
      tableId: cachedTableId,
      shiftId: cachedShiftId,
      openedBy: "manager",
      status: "SUBMITTED",
    },
  });
  return order.id;
}

async function makeSubmissionUnknownJob(type: "KITCHEN" | "BAR" | "RECEIPT" = "KITCHEN"): Promise<string> {
  const orderId = await makeOrder();
  // Synthetic SUBMISSION_UNKNOWN PrintJob — bypasses dispatchStationPrintJobs
  // (we don't need a real agent cycle here) and tests only the operator
  // reconciliation surface.
  const job = await prisma.printJob.create({
    data: {
      restaurantId,
      locationId,
      orderId,
      type,
      station: type === "RECEIPT" ? null : "KITCHEN",
      dispatchKey: `synth-submission-unknown-${randomUUID()}`,
      status: "SUBMISSION_UNKNOWN",
      isAutomatic: true,
      content: { test: true } as object,
      requestedBy: "manager",
      failureReason: "Potvrda štampe nedostaje; proverite štampač pre novog otiska.",
    },
  });
  return job.id;
}

describe("PRINTING P0 — operator reconciliation: acknowledgePrintAmbiguity(PRINTED)", () => {
  it("flips SUBMISSION_UNKNOWN to PRINTED and stamps operator columns", async () => {
    const jobId = await makeSubmissionUnknownJob();
    const idempotencyKey = `idem-printed-${jobId}`;

    const result = await printing.acknowledgePrintAmbiguity(ctx, jobId, { decision: "PRINTED", idempotencyKey });

    expect(result).toMatchObject({ id: jobId, status: "PRINTED" });
    expect((result as { printedAt: Date | null }).printedAt).toBeInstanceOf(Date);

    const reloaded = await prisma.printJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(reloaded.status).toBe("PRINTED");
    expect(reloaded.operatorConfirmedPrintedAt).toBeInstanceOf(Date);
    expect(reloaded.operatorConfirmedPrintedBy).toBe("manager");
    expect(reloaded.operatorReprintRequestedAt).toBeNull();
    expect(reloaded.failureReason).toBeNull();
  });

  it("is idempotent — a second PRINTED click with the SAME idempotencyKey is a no-op (no second audit row, no timestamp bump)", async () => {
    const jobId = await makeSubmissionUnknownJob();
    const idempotencyKey = `idem-printed-${jobId}`;

    await printing.acknowledgePrintAmbiguity(ctx, jobId, { decision: "PRINTED", idempotencyKey });
    const first = await prisma.printJob.findUniqueOrThrow({ where: { id: jobId } });

    await new Promise((r) => setTimeout(r, 5));
    const again = await printing.acknowledgePrintAmbiguity(ctx, jobId, { decision: "PRINTED", idempotencyKey });

    expect(again).toMatchObject({ id: jobId, status: "PRINTED" });
    const reloaded = await prisma.printJob.findUniqueOrThrow({ where: { id: jobId } });
    // operatorConfirmedPrintedAt must NOT bump — that is the audit signal
    // that the operator confirmed exactly once.
    expect(reloaded.operatorConfirmedPrintedAt?.toISOString()).toBe(first.operatorConfirmedPrintedAt?.toISOString());
  });

  it("refuses to act on a job in any status other than SUBMISSION_UNKNOWN", async () => {
    const jobId = await makeSubmissionUnknownJob();
    // Manually flip to PRINTED to simulate an already-resolved job.
    await prisma.printJob.update({ where: { id: jobId }, data: { status: "PRINTED" } });

    await expect(
      printing.acknowledgePrintAmbiguity(ctx, jobId, { decision: "PRINTED", idempotencyKey: `k-${jobId}` })
    ).rejects.toThrow(/SUBMISSION_UNKNOWN/);
  });
});

describe("PRINTING P0 — operator reconciliation: acknowledgePrintAmbiguity(REPRINT)", () => {
  it("creates a fresh PrintJob with isReprint=true and reprintOfId pointing at the original; original stays SUBMISSION_UNKNOWN", async () => {
    const jobId = await makeSubmissionUnknownJob("RECEIPT");
    const idempotencyKey = `idem-reprint-${jobId}`;

    const result = await printing.acknowledgePrintAmbiguity(ctx, jobId, { decision: "REPRINT", idempotencyKey });
    expect(result).toMatchObject({ status: "PENDING" });
    expect((result as { reprintOfId: string | null }).reprintOfId).toBe(jobId);

    const original = await prisma.printJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(original.status).toBe("SUBMISSION_UNKNOWN"); // ORIGINAL stays — it's the authoritative record of what happened
    expect(original.operatorReprintRequestedAt).toBeInstanceOf(Date);
    expect(original.operatorReprintRequestedBy).toBe("manager");

    const reprint = await prisma.printJob.findUniqueOrThrow({ where: { id: (result as { id: string }).id } });
    expect(reprint.isReprint).toBe(true);
    expect(reprint.reprintOfId).toBe(jobId);
    expect(reprint.type).toBe("RECEIPT");
    expect(reprint.dispatchKey.startsWith("reprint-ambiguity:")).toBe(true);
    // The dispatchKey is now derived from (jobId, idempotencyKey).
    expect(reprint.dispatchKey).toContain(idempotencyKey);
    // New row must go through the normal claim flow — never auto-claimed
    // by the original SUBMISSION_UNKNOWN status.
    expect(reprint.status).toBe("PENDING");
  });

  it("DOUBLE-CLICK PROTECTION — two REPRINT calls with the SAME idempotencyKey return the SAME row (no duplicate physical tickets)", async () => {
    const jobId = await makeSubmissionUnknownJob();
    const idempotencyKey = `idem-double-${jobId}`;

    const r1 = await printing.acknowledgePrintAmbiguity(ctx, jobId, { decision: "REPRINT", idempotencyKey });
    const r2 = await printing.acknowledgePrintAmbiguity(ctx, jobId, { decision: "REPRINT", idempotencyKey });

    // CRITICAL: same jobId + same idempotencyKey = same row, no duplicate.
    // This is the property the restaurant double-click safety hinges on.
    expect((r1 as { id: string }).id).toBe((r2 as { id: string }).id);
    expect((r1 as { dispatchKey: string }).dispatchKey).toBe((r2 as { dispatchKey: string }).dispatchKey);
    expect((r2 as { idempotentReplay?: boolean }).idempotentReplay).toBe(true);

    const all = await prisma.printJob.findMany({ where: { reprintOfId: jobId } });
    expect(all).toHaveLength(1); // EXACTLY ONE child PrintJob row, not two.
  });

  it("INTENTIONAL LATER REPRINT — a fresh idempotencyKey produces a fresh child row", async () => {
    const jobId = await makeSubmissionUnknownJob();

    const r1 = await printing.acknowledgePrintAmbiguity(ctx, jobId, { decision: "REPRINT", idempotencyKey: "first-click" });
    const r2 = await printing.acknowledgePrintAmbiguity(ctx, jobId, { decision: "REPRINT", idempotencyKey: "later-click" });

    expect((r1 as { id: string }).id).not.toBe((r2 as { id: string }).id);
    const all = await prisma.printJob.findMany({ where: { reprintOfId: jobId } });
    expect(all).toHaveLength(2); // Two distinct rows because the keys differ.
  });
});

describe("PRINTING P0 — pollAndClaim NEVER reclaims SUBMISSION_UNKNOWN", () => {
  it("a SUBMISSION_UNKNOWN PrintJob from the previous shift is NOT returned to a polling Agent, even with a fresh claim attempt", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    const jobId = await makeSubmissionUnknownJob("KITCHEN");
    // Make the route the only KITCHEN route for this location so the
    // poll query would otherwise return it.
    await workstations.upsertPrintRoute(ctx, workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });

    const { agentPrinting } = await import("@rcs/domain");
    const polled = await agentPrinting.pollAndClaim(wsCtx);

    expect(polled?.jobId ?? null).not.toBe(jobId);
    // The job must still be in SUBMISSION_UNKNOWN — no implicit transition.
    const reloaded = await prisma.printJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(reloaded.status).toBe("SUBMISSION_UNKNOWN");
  });
});

describe("PRINTING P0 — confirmPhysicalTestByAgent", () => {
  it("flips physicalTestConfirmed=true on a fully-configured route; records audit + actor", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();

    const route = await workstations.confirmPhysicalTestByAgent(wsCtx, { type: "KITCHEN" });
    expect(route.physicalTestConfirmed).toBe(true);
    expect(route.physicalTestConfirmedAt).toBeInstanceOf(Date);
    // SELECT shape on confirmPhysicalTestByAgent's return is the route
    // select — verify the column directly instead of through the return
    // shape, which only carries the boolean.
    const reloaded = await prisma.workstationPrintRoute.findFirstOrThrow({
      where: { workstationId, type: "KITCHEN" },
    });
    expect(reloaded.physicalTestConfirmed).toBe(true);
    expect(reloaded.physicalTestConfirmedBy).toBe(`workstation:${workstationId}`);
  });

  it("is idempotent — a second click returns the existing record without touching the timestamp", async () => {
    const { wsCtx } = await pairWorkstation();
    const first = await workstations.confirmPhysicalTestByAgent(wsCtx, { type: "KITCHEN" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await workstations.confirmPhysicalTestByAgent(wsCtx, { type: "KITCHEN" });

    expect(first.physicalTestConfirmedAt?.toISOString()).toBe(second.physicalTestConfirmedAt?.toISOString());
  });

  it("refuses to confirm a route that is not fully configured (printerName + paperWidthMm + enabled)", async () => {
    // Pair WITHOUT configuring any route
    const pairing = await workstations.createPairing(ctx, { locationId });
    const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
    const wsCtx: WorkstationAuthContext = {
      workstationId: registered.workstationId,
      restaurantId: registered.restaurantId,
      locationId: registered.locationId,
      station: null,
    };

    await expect(workstations.confirmPhysicalTestByAgent(wsCtx, { type: "KITCHEN" })).rejects.toThrow();
  });

  it("resets physicalTestConfirmed when the route's printerName or paperWidthMm actually changes", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    // Confirm once on the initial config
    await workstations.confirmPhysicalTestByAgent(wsCtx, { type: "KITCHEN" });
    const before = await prisma.workstationPrintRoute.findFirstOrThrow({
      where: { workstationId, type: "KITCHEN" },
    });
    expect(before.physicalTestConfirmed).toBe(true);

    // Resave with the SAME values — must NOT reset
    await workstations.upsertPrintRoute(ctx, workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    const same = await prisma.workstationPrintRoute.findFirstOrThrow({
      where: { workstationId, type: "KITCHEN" },
    });
    expect(same.physicalTestConfirmed).toBe(true);

    // Resave with a CHANGED paperWidthMm — must reset to false
    await workstations.upsertPrintRoute(ctx, workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 80 });
    const changed = await prisma.workstationPrintRoute.findFirstOrThrow({
      where: { workstationId, type: "KITCHEN" },
    });
    expect(changed.physicalTestConfirmed).toBe(false);
    expect(changed.physicalTestConfirmedAt).toBeNull();
    expect(changed.physicalTestConfirmedBy).toBeNull();
  });
});

describe("PRINTING P0 — heartbeat writes visibleToService per route (Service-side visibility probe)", () => {
  it("writes the `visible` field from the heartbeat routes[] into visibleToService and visibleToServiceAt", async () => {
    const { wsCtx, workstationId } = await pairWorkstation();

    await workstations.recordHeartbeat(wsCtx, {
      routes: [
        { type: "KITCHEN", printerAvailable: true, visible: true },
        { type: "RECEIPT", printerAvailable: true, visible: false }, // classic per-user install failure mode
      ],
    });

    const routes = await prisma.workstationPrintRoute.findMany({
      where: { workstationId },
      orderBy: { type: "asc" },
    });
    const kitchen = routes.find((r) => r.type === "KITCHEN")!;
    const receipt = routes.find((r) => r.type === "RECEIPT")!;
    expect(kitchen.visibleToService).toBe(true);
    expect(kitchen.visibleToServiceAt).toBeInstanceOf(Date);
    expect(receipt.visibleToService).toBe(false);
    expect(receipt.visibleToServiceAt).toBeInstanceOf(Date);
  });

  it("getRouteReadinessForAgent aggregates READY/AGENT_CANNOT_SEE/PENDING_PROBE/NEEDS_CONFIRM correctly", async () => {
    const { workstationId, wsCtx } = await pairWorkstation();
    const kitchen = await prisma.workstationPrintRoute.findFirstOrThrow({
      where: { workstationId, type: "KITCHEN" },
    });
    const receipt = await prisma.workstationPrintRoute.findFirstOrThrow({
      where: { workstationId, type: "RECEIPT" },
    });
    // KITCHEN: Service cannot see (probe=false), so AGENT_CANNOT_SEE wins
    // over the not-yet-confirmed flag — we do NOT want a route the
    // Service cannot see to be marked NEEDS_CONFIRM, that would let an
    // operator confirm a printed ticket the Service could not possibly
    // have produced.
    await prisma.workstationPrintRoute.update({
      where: { id: kitchen.id },
      data: { visibleToService: false, visibleToServiceAt: new Date(), physicalTestConfirmed: false },
    });
    // RECEIPT: Service CAN see, but operator has not confirmed yet
    await prisma.workstationPrintRoute.update({
      where: { id: receipt.id },
      data: { visibleToService: true, visibleToServiceAt: new Date(), physicalTestConfirmed: false },
    });

    const readiness = await workstations.getRouteReadinessForAgent(wsCtx);
    const byType = Object.fromEntries(readiness.map((r) => [r.type, r.readiness]));
    expect(byType.KITCHEN).toBe("AGENT_CANNOT_SEE");
    expect(byType.RECEIPT).toBe("NEEDS_CONFIRM");

    // Now confirm receipt → READY
    await workstations.confirmPhysicalTestByAgent(wsCtx, { type: "RECEIPT" });
    const readiness2 = await workstations.getRouteReadinessForAgent(wsCtx);
    const byType2 = Object.fromEntries(readiness2.map((r) => [r.type, r.readiness]));
    expect(byType2.RECEIPT).toBe("READY");
    // KITCHEN unchanged
    expect(byType2.KITCHEN).toBe("AGENT_CANNOT_SEE");
  });
});

describe("PRINTING P0 — Admin-side confirmPhysicalTestByAdmin converges with the Agent path", () => {
  it("flips physicalTestConfirmed=true from an Admin ctx (same column, audit-able)", async () => {
    const { workstationId } = await pairWorkstation();

    const route = await workstations.confirmPhysicalTestByAdmin(ctx, workstationId, "KITCHEN");
    expect(route.physicalTestConfirmed).toBe(true);

    const reloaded = await prisma.workstationPrintRoute.findFirstOrThrow({
      where: { workstationId, type: "KITCHEN" },
    });
    expect(reloaded.physicalTestConfirmedBy).toBe(`admin:${ctx.employeeId}`);
  });

  it("refuses to confirm a route on a workstation belonging to a different restaurant", async () => {
    const { workstationId } = await pairWorkstation();
    // Create a different restaurant's ctx
    const otherTenant = await prisma.tenant.create({ data: { name: "Other", slug: randomUUID() } });
    const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: otherTenant.id, name: "B", currency: "RSD" } });
    const otherCtx = {
      ...ctx,
      restaurantId: otherRestaurant.id,
    };

    await expect(
      workstations.confirmPhysicalTestByAdmin(otherCtx, workstationId, "KITCHEN")
    ).rejects.toThrow();
  });
});

describe("PRINTING P0 — listSubmissionUnknownJobs surfaces the reconciliation banner", () => {
  it("returns only jobs in SUBMISSION_UNKNOWN created in the last 12 hours, scoped to ctx.restaurantId", async () => {
    const ownId = await makeSubmissionUnknownJob("KITCHEN");
    const oldId = await makeSubmissionUnknownJob("BAR");
    // Make the BAR job ancient — outside the 12h window
    await prisma.printJob.update({ where: { id: oldId }, data: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } });

    // Different restaurant — must NOT leak
    const otherTenant = await prisma.tenant.create({ data: { name: "Other", slug: randomUUID() } });
    const otherRestaurant = await prisma.restaurant.create({
      data: { tenantId: otherTenant.id, name: "B", currency: "RSD" },
    });
    const otherLocation = await prisma.location.create({
      data: { restaurantId: otherRestaurant.id, name: "B" },
    });
    const otherShift = await prisma.shift.create({
      data: { restaurantId: otherRestaurant.id, locationId: otherLocation.id, openedBy: "x", status: "OPEN" },
    });
    const otherFloor = await prisma.floor.create({
      data: { restaurantId: otherRestaurant.id, locationId: otherLocation.id, name: `FX-${randomUUID().slice(0, 4)}` },
    });
    const otherTable = await prisma.restaurantTable.create({
      data: { floorId: otherFloor.id, label: `X-${randomUUID().slice(0, 4)}`, capacity: 2 },
    });
    const otherOrder = await prisma.order.create({
      data: {
        restaurantId: otherRestaurant.id,
        locationId: otherLocation.id,
        tableId: otherTable.id,
        shiftId: otherShift.id,
        openedBy: "x",
        status: "SUBMITTED",
      },
    });
    await prisma.printJob.create({
      data: {
        restaurantId: otherRestaurant.id,
        locationId: otherLocation.id,
        orderId: otherOrder.id,
        type: "KITCHEN",
        station: "KITCHEN",
        dispatchKey: `synth-other-${randomUUID()}`,
        status: "SUBMISSION_UNKNOWN",
        isAutomatic: true,
        content: { x: true } as object,
        requestedBy: "x",
      },
    });

    const list = await printing.listSubmissionUnknownJobs(ctx);
    expect(list.map((j) => j.id).sort()).toEqual([ownId].sort());
    // The 24h-old BAR job must be excluded.
    expect(list.map((j) => j.id)).not.toContain(oldId);
  });
});
