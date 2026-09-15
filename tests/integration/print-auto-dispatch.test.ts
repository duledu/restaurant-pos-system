import { confirmPrint } from "../setup/print-attempt";
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, printing, workstations, agentPrinting } from "@rcs/domain";
import type { WorkstationAuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  kitchenItemId: string;
  barItemId: string;
}

function context(fixture: Fixture, roles: string[], employeeId: string): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles,
    permissions: new Set(["orders.print", "production.view", "production.manage"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "AutoPrint tenant", slug: `autoprint-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T9" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const kitchenItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Cevapi",
      slug: `cevapi-${randomUUID()}`,
      price: "700.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });
  const barItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Pivo",
      slug: `pivo-${randomUUID()}`,
      price: "300.00",
      taxRate: "20",
      preparationStation: "BAR",
    },
  });

  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, kitchenItemId: kitchenItem.id, barItemId: barItem.id };
}

async function submitMixedOrder(fixture: Fixture, waiter: AuthContext) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.barItemId, quantity: 1 });
  return orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("automatic print dispatch: paper width snapshot per station", () => {
  it("defaults to 80mm for both stations when no PrinterConfig exists", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    const barJob = jobs.find((j) => j.type === "BAR")!;
    expect((kitchenJob.content as { paperWidthMm: number }).paperWidthMm).toBe(80);
    expect((barJob.content as { paperWidthMm: number }).paperWidthMm).toBe(80);
  });

  it("Kitchen and Bar can carry independent paper widths (80mm vs 58mm) on the same order", async () => {
    const fixture = await createFixture();
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", autoPrint: true, paperWidthMm: 80 },
    });
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "BAR", name: "Šank", autoPrint: true, paperWidthMm: 58 },
    });
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    const barJob = jobs.find((j) => j.type === "BAR")!;
    expect((kitchenJob.content as { paperWidthMm: number }).paperWidthMm).toBe(80);
    expect((barJob.content as { paperWidthMm: number }).paperWidthMm).toBe(58);
  });
});

describe("automatic print dispatch: atomic claim (beginPrintAttempt) prevents duplicate auto-print", () => {
  it("claims a PENDING job exactly once under concurrent auto-print attempts (refresh/poll/retry race)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;

    const attempts = await Promise.all([
      printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id),
      printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id),
      printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id),
      printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id),
      printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id),
    ]);
    const claimed = attempts.filter((a) => a !== null);
    expect(claimed).toHaveLength(1);

    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } });
    expect(row.status).toBe("PRINTING");
    expect(row.attemptCount).toBe(1);
  });

  it("refuses to claim a job that is not PENDING (already PRINTING/PRINTED/FAILED) — no re-trigger on refresh after a completed attempt", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;

    const first = await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    expect(first).not.toBeNull();
    await confirmPrint(kitchenStaff, submitted.id, kitchenJob.id, { success: true });

    // Simulates the KDS screen re-discovering the same job on the next 4s
    // poll or a full page refresh — it must never fire window.print() again.
    const second = await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    expect(second).toBeNull();
  });

  it("a KITCHEN-role employee cannot claim a BAR print job (station RBAC, same guard as the KDS screen)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const barJob = jobs.find((j) => j.type === "BAR")!;

    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    await expect(printing.beginPrintAttempt(kitchenStaff, submitted.id, barJob.id)).rejects.toThrow();
  });

  it("recovers a stale PRINTING claim back to PENDING (tab/browser crash after claim, before submission start) — never permanently lost, never re-triggers business effects", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;

    const claimed = await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    expect(claimed).not.toBeNull();

    // Simulate the claiming tab/browser crashing before startPrintSubmission
    // ever runs — backdate claimedAt past STALE_PRINT_LEASE_MS (90s), the
    // same signal listPendingStationPrintJobs checks (see print-service.ts).
    await prisma.printJob.update({
      where: { id: kitchenJob.id },
      data: { claimedAt: new Date(Date.now() - 91_000) },
    });

    const result = await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");
    const recovered = result.jobs.find((j) => j.id === kitchenJob.id);
    expect(recovered?.status).toBe("PENDING");

    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } });
    expect(row.status).toBe("PENDING");
    // Recovery only resets status — it must never touch the order/KDS state
    // that already exists independently of this print job.
    expect(await prisma.order.count({ where: { id: submitted.id } })).toBe(1);
    expect(await prisma.orderItemStation.count({ where: { orderItem: { orderId: submitted.id }, station: "KITCHEN" } })).toBeGreaterThan(0);

    // Recovered job is claimable again exactly once — same idempotent path
    // as any other PENDING job, no second/competing recovery queue.
    const reclaimed = await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.status).toBe("PRINTING");
  });

  it("KDS polling optimization (final performance pass) — does NOT run stale-claim recovery from the read path when a live Print Agent workstation is active for the station; recovery ownership shifts entirely to the agent's own pollAndClaim, never permanently stuck either way", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const registered = await pairActiveWorkstation(fixture, "KITCHEN", owner);

    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;

    const claimed = await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    expect(claimed).not.toBeNull();

    // Same stale backdating as the no-agent recovery test above, but this
    // time a live Agent workstation exists for the station.
    const staleClaimedAt = new Date(Date.now() - 91_000);
    await prisma.printJob.update({
      where: { id: kitchenJob.id },
      data: { claimedAt: staleClaimedAt },
    });

    // The KDS read path (what every open Kitchen/BAR tab polls every ~4s)
    // must be a pure read here — it must NOT mutate this stale row itself.
    const result = await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");
    expect(result.jobs.find((j) => j.id === kitchenJob.id)).toBeUndefined();
    const untouched = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } });
    expect(untouched.status).toBe("PRINTING");
    expect(untouched.claimedAt?.getTime()).toBe(staleClaimedAt.getTime());

    // Proof it is never permanently stuck: the agent's own poll/claim loop
    // (which runs independently of any KDS tab, on its own faster cadence)
    // still recovers it exactly as before.
    const wsCtx: WorkstationAuthContext = {
      workstationId: registered.workstationId,
      restaurantId: registered.restaurantId,
      locationId: registered.locationId,
      station: registered.station,
    };
    await agentPrinting.pollAndClaim(wsCtx);
    const recovered = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } });
    expect(recovered.status).toBe("PENDING");
  });

  it("does NOT recover a PRINTING claim that is still within the lease window (fresh in-progress print is left alone)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;

    await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");

    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } });
    expect(row.status).toBe("PRINTING");
  });
});

describe("automatic print dispatch: station queue listing", () => {
  it("KITCHEN listing returns only KITCHEN jobs (PENDING + FAILED), never BAR", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    // Management sees both stations (assertStationAccess) — a single
    // realistic actor can't hold both KITCHEN and BAR roles at once, and
    // that cross-station denial is proven separately above.
    const manager = context(fixture, ["MANAGER"], "manager-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const barJob = jobs.find((j) => j.type === "BAR")!;
    await confirmPrint(manager, submitted.id, barJob.id, { success: false, errorMessage: "Printer offline" });

    const kitchenResult = await printing.listPendingStationPrintJobs(manager, fixture.locationId, "KITCHEN");
    expect(kitchenResult.jobs.every((j) => j.station === "KITCHEN")).toBe(true);
    expect(kitchenResult.jobs.some((j) => j.status === "PENDING")).toBe(true);

    const barResult = await printing.listPendingStationPrintJobs(manager, fixture.locationId, "BAR");
    expect(barResult.jobs).toHaveLength(1);
    expect(barResult.jobs[0].status).toBe("FAILED");
  });

  it("excludes PRINTED jobs from the pending/failed listing (no re-surfacing an already-printed ticket)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    await confirmPrint(kitchenStaff, submitted.id, kitchenJob.id, { success: true });

    const result = await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");
    expect(result.jobs).toHaveLength(0);
  });

  it("autoPrintEligible defaults to true with no PrinterConfig row, and reflects isEnabled=false once configured", async () => {
    const fixture = await createFixture();
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");

    const beforeConfig = await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");
    expect(beforeConfig.autoPrintEligible).toBe(true);

    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", isEnabled: false },
    });
    const afterConfig = await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");
    expect(afterConfig.autoPrintEligible).toBe(false);
  });
});

async function pairActiveWorkstation(fixture: Fixture, station: "KITCHEN" | "BAR", ownerCtx: AuthContext) {
  const pairing = await workstations.createPairing(ownerCtx, { locationId: fixture.locationId, station });
  const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
  // Simulates a heartbeat that already reported a configured, available
  // printer with its own paper width — exactly what AgentRunner.cs's
  // SendHeartbeat sends every ~25s while the Windows Print Agent runs.
  await prisma.workstation.update({
    where: { id: registered.workstationId },
    data: { lastSeenAt: new Date(), configuredPrinterName: "POS-58", printerAvailable: true, paperWidthMm: 58 },
  });
  return registered;
}

describe("automatic print dispatch: Print Agent readiness overrides legacy Browser/QZ config (Problem 2 fix)", () => {
  it("still creates the automatic KITCHEN PrintJob when legacy PrinterConfig has autoPrint=false, as long as a live Print Agent workstation exists for that station", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    // The exact latent risk this fixes: an explicit legacy row with
    // autoPrint=false must NOT silently block the agent-servisced station.
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", autoPrint: false, isEnabled: true },
    });
    await pairActiveWorkstation(fixture, "KITCHEN", owner);

    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN");
    expect(kitchenJob).toBeDefined();
    expect(kitchenJob?.status).toBe("PENDING");
    expect(kitchenJob?.isAutomatic).toBe(true);
  });

  it("uses the active workstation's own reported paper width, not the legacy PrinterConfig value, once a Print Agent is live for that station", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", autoPrint: true, isEnabled: true, paperWidthMm: 80 },
    });
    await pairActiveWorkstation(fixture, "KITCHEN", owner); // reports paperWidthMm: 58 via heartbeat

    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    expect((kitchenJob.content as { paperWidthMm: number }).paperWidthMm).toBe(58);
  });

  it("still respects legacy autoPrint=false when NO Print Agent workstation is active for that station (manual/fallback path unaffected)", async () => {
    const fixture = await createFixture();
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", autoPrint: false, isEnabled: true },
    });
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    expect(jobs.find((j) => j.type === "KITCHEN")).toBeUndefined();
  });

  it("does not suppress PENDING automatic jobs for a station with a live Print Agent, even if legacy autoPrint is off (KDS listing must not delete work the agent can still claim)", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    await pairActiveWorkstation(fixture, "KITCHEN", owner);
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;

    // Now the admin flips the LEGACY box off — the agent should be
    // completely unaffected. A KDS tab open on this station must never
    // suppress the job the agent can still serve.
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", autoPrint: false, isEnabled: true },
    });
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");

    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } });
    expect(row.status).toBe("PENDING");
  });
});

describe("automatic print dispatch: the CLAIM step itself must not be blocked by legacy config (hardening audit finding)", () => {
  it("agentPrinting.pollAndClaim actually succeeds even when legacy autoPrint=false, for a live Agent workstation (dispatch alone bypassing the legacy gate is not enough — the claim step had the same gate)", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", autoPrint: false, isEnabled: true },
    });
    const registered = await pairActiveWorkstation(fixture, "KITCHEN", owner);
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    await submitMixedOrder(fixture, waiter);

    const wsCtx: WorkstationAuthContext = {
      workstationId: registered.workstationId,
      restaurantId: registered.restaurantId,
      locationId: registered.locationId,
      station: registered.station,
    };
    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed).not.toBeNull();
    expect(claimed?.station).toBe("KITCHEN");
  });

  it("legacy PrinterConfig.isEnabled=false does NOT block the claim while the Agent workstation is active — both legacy gates (isEnabled and autoPrint) are equally irrelevant to the Agent path, by design", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    // Explicit master-disabled legacy row — this must be exactly as
    // irrelevant to the Agent path as autoPrint=false is (both are
    // Browser/QZ-only concerns once a live Workstation owns the station).
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", isEnabled: false, autoPrint: false },
    });
    const registered = await pairActiveWorkstation(fixture, "KITCHEN", owner);
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    await submitMixedOrder(fixture, waiter);

    const wsCtx: WorkstationAuthContext = {
      workstationId: registered.workstationId,
      restaurantId: registered.restaurantId,
      locationId: registered.locationId,
      station: registered.station,
    };
    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed).not.toBeNull();
  });

  it("the WORKSTATION's own isEnabled=false (not legacy PrinterConfig) is the correct, real control surface for pausing an Agent-served station — activeWorkstationFor stops treating it as active as soon as it's disabled", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const registered = await pairActiveWorkstation(fixture, "KITCHEN", owner); // reports paperWidthMm: 58

    // Admin uses "Podešavanja" (updateWorkstation) to pause this exact
    // workstation — the intended control surface in the Agent world,
    // reversible unlike revoke.
    await workstations.updateWorkstation(owner, registered.workstationId, { isEnabled: false });

    // A new order dispatched now must fall back to the legacy default
    // (80mm, no PrinterConfig row) rather than the disabled workstation's
    // own 58mm — direct proof that activeWorkstationFor no longer
    // considers it "active" the instant isEnabled flips to false.
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    expect((kitchenJob.content as { paperWidthMm: number }).paperWidthMm).toBe(80);
  });
});

describe("'Pokušaj ponovo' retry routing (hardening audit finding)", () => {
  it("retrying a failed automatic job keeps isAutomatic=true when a live Agent owns the station, so the Agent's own fast poll reclaims it", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const registered = await pairActiveWorkstation(fixture, "KITCHEN", owner);
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    expect(kitchenJob.isAutomatic).toBe(true);

    const wsCtx: WorkstationAuthContext = {
      workstationId: registered.workstationId,
      restaurantId: registered.restaurantId,
      locationId: registered.locationId,
      station: registered.station,
    };
    // Agent claims and reports a real driver failure (e.g. printable area).
    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed).not.toBeNull();
    await agentPrinting.submitResult(wsCtx, claimed!.jobId, claimed!.attemptId, "FAILED_BEFORE_SUBMISSION", "Driver printable area is too small for this ticket.");
    expect((await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } })).status).toBe("FAILED");

    // Operator clicks "Pokušaj ponovo" on the KDS screen.
    const retried = await printing.retryPrintJob(kitchenStaff, submitted.id, kitchenJob.id);
    expect(retried.status).toBe("PENDING");
    expect(retried.isAutomatic).toBe(true); // the actual bug this closes: used to force false, hiding it from pollAndClaim forever

    // The Agent's own next poll (not a manual KDS/browser claim) must be
    // able to pick this exact job back up.
    const reclaimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(reclaimed?.jobId).toBe(kitchenJob.id);
  });

  it("retrying with NO active Agent for the station preserves the original manual-retry behavior (isAutomatic=false, immediate claim by the caller)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    const claim = (await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id))!;
    await printing.confirmPrintResult(kitchenStaff, submitted.id, kitchenJob.id, { attemptId: claim.attemptId!, outcome: "FAILED_BEFORE_SUBMISSION" });

    const retried = await printing.retryPrintJob(kitchenStaff, submitted.id, kitchenJob.id);
    expect(retried.isAutomatic).toBe(false);
  });
});

describe("stale/offline workstation correctly falls back to legacy policy (hardening audit — heartbeat freshness)", () => {
  it("a workstation that stopped heartbeating (stale lastSeenAt) is no longer 'active' — dispatch falls back to legacy PrinterConfig, exactly as if no Agent ever existed", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const registered = await pairActiveWorkstation(fixture, "KITCHEN", owner); // reports paperWidthMm: 58
    // Simulate the Agent process being gone/offline for well beyond the
    // 2-minute AGENT_ACTIVE_WINDOW_MS threshold (print-policy.ts) — no new
    // heartbeat has landed, this is a real "PC turned off"/"network down"
    // scenario, not a revoke or disable.
    await prisma.workstation.update({
      where: { id: registered.workstationId },
      data: { lastSeenAt: new Date(Date.now() - 5 * 60 * 1000) },
    });
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", autoPrint: true, paperWidthMm: 80 },
    });

    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    // Legacy paper width (80), NOT the offline workstation's own (58) —
    // proves the stale workstation is genuinely excluded, not merely
    // deprioritized.
    expect((kitchenJob.content as { paperWidthMm: number }).paperWidthMm).toBe(80);

    // And the offline workstation's own credential naturally finds nothing
    // to claim (it isn't heartbeating, so in reality it wouldn't even be
    // polling — this proves the job is reachable through the legacy/manual
    // path instead, matching stationPrinterStatus's "Print Agent offline"
    // KDS state rather than a silently vanished ticket).
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    expect(await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id)).not.toBeNull();
  });
});

describe("stationPrinterStatus — one authoritative discriminated readiness state (hardening audit Part 13)", () => {
  it("NOT_CONFIGURED when no workstation was ever paired for the station", async () => {
    const fixture = await createFixture();
    const status = await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN");
    expect(status).toEqual({ hasWorkstation: false, isOnline: false, state: "NOT_CONFIGURED" });
  });

  it("AGENT_OFFLINE when a workstation exists but hasn't heartbeated within the freshness window", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const registered = await pairActiveWorkstation(fixture, "KITCHEN", owner);
    await prisma.workstation.update({
      where: { id: registered.workstationId },
      data: { lastSeenAt: new Date(Date.now() - 5 * 60 * 1000) },
    });
    const status = await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN");
    expect(status.state).toBe("AGENT_OFFLINE");
    expect(status.hasWorkstation).toBe(true);
    expect(status.isOnline).toBe(false);
  });

  it("PRINTER_UNAVAILABLE when the Agent is online but the configured Windows printer is missing (printerAvailable=false) — must NOT report READY", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const registered = await pairActiveWorkstation(fixture, "KITCHEN", owner);
    await prisma.workstation.update({
      where: { id: registered.workstationId },
      data: { printerAvailable: false },
    });
    const status = await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN");
    expect(status.state).toBe("PRINTER_UNAVAILABLE");
  });

  it("PRINTER_UNAVAILABLE when the Agent is online but has never reported a configured printer at all (fresh pairing, printerAvailable=null)", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const pairing = await workstations.createPairing(owner, { locationId: fixture.locationId, station: "KITCHEN" });
    const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
    // Heartbeat WITHOUT ever reporting a printer — printerAvailable stays
    // null (never reported), configuredPrinterName stays null.
    await prisma.workstation.update({ where: { id: registered.workstationId }, data: { lastSeenAt: new Date() } });
    const status = await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN");
    expect(status.state).toBe("PRINTER_UNAVAILABLE");
  });

  it("READY only when online AND a specific printer is both configured and confirmed available", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    await pairActiveWorkstation(fixture, "KITCHEN", owner); // reports configuredPrinterName + printerAvailable:true
    const status = await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN");
    expect(status).toEqual({ hasWorkstation: true, isOnline: true, state: "READY" });
  });

  it("a revoked workstation is treated exactly like NOT_CONFIGURED — revocation must not leave a lingering 'offline' state", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const registered = await pairActiveWorkstation(fixture, "KITCHEN", owner);
    await workstations.revokeWorkstation(owner, registered.workstationId);
    const status = await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN");
    expect(status.state).toBe("NOT_CONFIGURED");
  });
});

describe("hasRecentPrintFailure — 'Poslednja stampa nije uspela' reflects CURRENT operational health, not lifetime PrintJob history (PREPROD physical QA follow-up)", () => {
  it("an unresolved recent failure (this shift, nothing since) produces a warning", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, ["MANAGER"], "manager-1");
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    await prisma.printJob.update({ where: { id: kitchenJob.id }, data: { status: "FAILED", resultOutcome: "FAILED_BEFORE_SUBMISSION" } });

    expect(await printing.hasRecentPrintFailure(manager, fixture.locationId, "KITCHEN")).toBe(true);
  });

  it("a later successful print for the same station clears the warning (a success always supersedes an earlier failure in the same shift)", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, ["MANAGER"], "manager-1");
    const waiter = context(fixture, ["WAITER"], "waiter-1");

    const failedOrder = await submitMixedOrder(fixture, waiter);
    const failedJobs = await printing.listPrintJobs(waiter, failedOrder.id);
    const failedKitchenJob = failedJobs.find((j) => j.type === "KITCHEN")!;
    await prisma.printJob.update({ where: { id: failedKitchenJob.id }, data: { status: "FAILED", resultOutcome: "FAILED_BEFORE_SUBMISSION", createdAt: new Date(Date.now() - 60_000) } });
    expect(await printing.hasRecentPrintFailure(manager, fixture.locationId, "KITCHEN")).toBe(true);

    // Printer recovers — a later order's KITCHEN ticket prints successfully.
    const recoveredOrder = await submitMixedOrder(fixture, waiter);
    const recoveredJobs = await printing.listPrintJobs(waiter, recoveredOrder.id);
    const recoveredKitchenJob = recoveredJobs.find((j) => j.type === "KITCHEN")!;
    await prisma.printJob.update({ where: { id: recoveredKitchenJob.id }, data: { status: "PRINTED", printedAt: new Date() } });

    expect(await printing.hasRecentPrintFailure(manager, fixture.locationId, "KITCHEN")).toBe(false);
  });

  it("a failure from a PREVIOUS (now-closed) shift does not create a permanent warning in the new shift — no F5-proof stale banner across shift boundaries", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, ["MANAGER"], "manager-1");
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    await prisma.printJob.update({ where: { id: kitchenJob.id }, data: { status: "FAILED", resultOutcome: "FAILED_BEFORE_SUBMISSION" } });
    expect(await printing.hasRecentPrintFailure(manager, fixture.locationId, "KITCHEN")).toBe(true);

    // Shift ends (this failure is now history, not current health) and a
    // brand-new shift opens — PrintJob history is untouched (still FAILED,
    // still visible in Admin/audit), only which shift counts as "current" changes.
    await prisma.shift.updateMany({ where: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, status: "OPEN" }, data: { status: "CLOSED", closedBy: "manager-1", closedAt: new Date() } });
    await prisma.shift.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, openedBy: "manager-1" } });

    expect(await printing.hasRecentPrintFailure(manager, fixture.locationId, "KITCHEN")).toBe(false);
    // History itself is untouched — the old FAILED row still exists exactly as before.
    const historicalRow = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } });
    expect(historicalRow.status).toBe("FAILED");
  });

  it("a current SUBMISSION_UNKNOWN (Agent/printer failure) still produces a warning — the fix must not hide genuine current failures", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, ["MANAGER"], "manager-1");
    const owner = context(fixture, ["OWNER"], "owner-1");
    await pairActiveWorkstation(fixture, "KITCHEN", owner);
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    await prisma.printJob.update({ where: { id: kitchenJob.id }, data: { status: "SUBMISSION_UNKNOWN", failureReason: "Potvrda stampe nedostaje." } });

    expect(await printing.hasRecentPrintFailure(manager, fixture.locationId, "KITCHEN")).toBe(true);
  });

  it("a station that has not printed anything yet this shift reports no failure (never warns from silence/no activity)", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, ["MANAGER"], "manager-1");
    expect(await printing.hasRecentPrintFailure(manager, fixture.locationId, "KITCHEN")).toBe(false);
  });

  it("does not cross-contaminate between stations — a KITCHEN failure never sets the BAR warning", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, ["MANAGER"], "manager-1");
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    await prisma.printJob.update({ where: { id: kitchenJob.id }, data: { status: "FAILED", resultOutcome: "FAILED_BEFORE_SUBMISSION" } });

    expect(await printing.hasRecentPrintFailure(manager, fixture.locationId, "KITCHEN")).toBe(true);
    expect(await printing.hasRecentPrintFailure(manager, fixture.locationId, "BAR")).toBe(false);
  });
});
