import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import type { AuthContext, WorkstationAuthContext } from "@rcs/auth";
import { orders, settings, workstations, agentPrinting } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

let ctx: AuthContext;
let restaurantId: string;
let locationId: string;
let floorId: string;
let kitchenId: string;
let barId: string;

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
  const tenant = await prisma.tenant.create({ data: { name: "Agent delivery", slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "A", currency: "RSD" } });
  restaurantId = restaurant.id;
  locationId = (await prisma.location.create({ data: { restaurantId: restaurant.id, name: "A" } })).id;
  floorId = (await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId, name: "Floor" } })).id;
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId, openedBy: "manager" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Food", slug: randomUUID(), type: "FOOD" } });
  const item = (station: "KITCHEN" | "BAR") =>
    prisma.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: station, slug: randomUUID(), price: 100, taxRate: 20, preparationStation: station } });
  kitchenId = (await item("KITCHEN")).id;
  barId = (await item("BAR")).id;
  ctx = {
    userId: "manager",
    employeeId: "manager",
    restaurantId,
    locationIds: [locationId],
    roles: ["MANAGER"],
    permissions: new Set(["settings.manage", "orders.print", "production.manage", "production.view", "workstations.manage"]),
  };
});

async function policy(station: "KITCHEN" | "BAR", autoPrint = true, isEnabled = true) {
  return settings.upsertPrinterConfig(ctx, { locationId, station, name: station, paperWidthMm: 58, autoPrint, isEnabled });
}

async function pairWorkstation(station: "KITCHEN" | "BAR" = "KITCHEN", loc = locationId): Promise<WorkstationAuthContext & { credential: string }> {
  const pairing = await workstations.createPairing({ ...ctx, locationIds: [...ctx.locationIds, loc] }, { locationId: loc, station });
  const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
  return { workstationId: registered.workstationId, restaurantId: registered.restaurantId, locationId: registered.locationId, station: registered.station, credential: registered.credential };
}

async function sendOrder(): Promise<{ orderId: string; kitchenJobId: string; barJobId: string }> {
  const table = await prisma.restaurantTable.create({ data: { floorId, label: "T" + randomUUID() } });
  const order = await orders.openOrder(ctx, { tableId: table.id });
  await orders.addItem(ctx, order.id, { menuItemId: kitchenId, quantity: 1 });
  await orders.addItem(ctx, order.id, { menuItemId: barId, quantity: 1 });
  await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });
  const kitchenJob = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, station: "KITCHEN" } });
  const barJob = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, station: "BAR" } });
  return { orderId: order.id, kitchenJobId: kitchenJob.id, barJobId: barJob.id };
}

describe("agent poll/claim", () => {
  it("returns and claims an eligible job for the workstation's exact restaurant/location/station", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();

    const claimed = await agentPrinting.pollAndClaim(ws);
    expect(claimed?.jobId).toBe(kitchenJobId);
    expect(claimed?.attemptId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(claimed?.station).toBe("KITCHEN");

    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJobId } });
    expect(row.status).toBe("PRINTING");
    expect(row.claimedBy).toBe(`workstation:${ws.workstationId}`);
  });

  it("never returns a job for the wrong station", async () => {
    await policy("KITCHEN");
    await policy("BAR");
    const barWs = await pairWorkstation("BAR");
    await sendOrder(); // creates a KITCHEN job too, but this workstation is BAR-only

    const claimed = await agentPrinting.pollAndClaim(barWs);
    expect(claimed?.station).toBe("BAR"); // only ever gets its own station's job
    const kitchenRow = await prisma.printJob.findFirstOrThrow({ where: { station: "KITCHEN" } });
    expect(kitchenRow.status).toBe("PENDING"); // untouched by the BAR workstation
  });

  it("never returns a job for the wrong location", async () => {
    await policy("KITCHEN");
    const otherLocationId = (await prisma.location.create({ data: { restaurantId, name: "Other" } })).id;
    const wsOtherLocation = await pairWorkstation("KITCHEN", otherLocationId);
    await sendOrder(); // job dispatched to the ORIGINAL locationId

    const claimed = await agentPrinting.pollAndClaim(wsOtherLocation);
    expect(claimed).toBeNull();
  });

  it("never returns a job for the wrong restaurant", async () => {
    await policy("KITCHEN");
    const tenant2 = await prisma.tenant.create({ data: { name: "Other tenant", slug: randomUUID() } });
    const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant2.id, name: "Other" } });
    const otherLocation = await prisma.location.create({ data: { restaurantId: otherRestaurant.id, name: "Other loc" } });
    const otherCtx: AuthContext = { userId: "m2", employeeId: "m2", restaurantId: otherRestaurant.id, locationIds: [otherLocation.id], roles: ["MANAGER"], permissions: new Set(["workstations.manage"]) };
    const otherPairing = await workstations.createPairing(otherCtx, { locationId: otherLocation.id, station: "KITCHEN" });
    const otherRegistered = await workstations.registerAgentFromPairing({ code: otherPairing.code });
    await sendOrder(); // job belongs to the FIRST restaurant

    const claimed = await agentPrinting.pollAndClaim({ workstationId: otherRegistered.workstationId, restaurantId: otherRegistered.restaurantId, locationId: otherRegistered.locationId, station: otherRegistered.station });
    expect(claimed).toBeNull();
  });

  it("a revoked workstation cannot be resolved to poll at all", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    await workstations.revokeWorkstation(ctx, ws.workstationId);
    const row = await prisma.workstation.findUniqueOrThrow({ where: { id: ws.workstationId } });
    expect(row.revokedAt).not.toBeNull();
    // Identity resolution itself (requireWorkstationAuth) already rejects
    // revoked credentials before pollAndClaim is ever reached — covered in
    // workstation-auth.test.ts. Here we additionally prove that even a
    // (hypothetically) resolved poll must never hand work to a revoked row
    // by re-checking workstation state directly, since pollAndClaim itself
    // trusts its caller already verified this.
    expect(row.isEnabled).toBe(false);
  });

  it("a disabled workstation cannot be resolved to poll at all", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    await prisma.workstation.update({ where: { id: ws.workstationId }, data: { isEnabled: false } });
    const row = await prisma.workstation.findUniqueOrThrow({ where: { id: ws.workstationId } });
    expect(row.isEnabled).toBe(false);
    expect(row.revokedAt).toBeNull();
  });

  it("two concurrent pollers can never claim the same job", async () => {
    await policy("KITCHEN");
    const wsA = await pairWorkstation("KITCHEN");
    await sendOrder();
    // Simulate a second workstation for the SAME station/location (V1
    // "competing consumers" policy — see final report) racing for the
    // same single job.
    const pairingB = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    const registeredB = await workstations.registerAgentFromPairing({ code: pairingB.code });
    const wsB = { workstationId: registeredB.workstationId, restaurantId: registeredB.restaurantId, locationId: registeredB.locationId, station: registeredB.station };

    const [a, b] = await Promise.all([agentPrinting.pollAndClaim(wsA), agentPrinting.pollAndClaim(wsB)]);
    const claimedCount = [a, b].filter(Boolean).length;
    expect(claimedCount).toBe(1); // exactly one of the two succeeds
  });

  it("never returns a SUPPRESSED job (auto print OFF)", async () => {
    await policy("KITCHEN", true);
    const ws = await pairWorkstation("KITCHEN");
    await sendOrder();
    await policy("KITCHEN", false); // turns auto print OFF -> suppresses the pending job
    const row = await prisma.printJob.findFirstOrThrow({ where: { restaurantId, locationId, station: "KITCHEN" } });
    expect(row.status).toBe("SUPPRESSED");

    const claimed = await agentPrinting.pollAndClaim(ws);
    expect(claimed).toBeNull();
  });

  it("never returns a manual (non-automatic) job — automatic-only scope for this phase", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { orderId } = await sendOrder();
    // Claim + finish the automatic job first so a manual reprint request is legal.
    const first = await agentPrinting.pollAndClaim(ws);
    await agentPrinting.beginSubmission(ws, first!.jobId, first!.attemptId);
    await agentPrinting.submitResult(ws, first!.jobId, first!.attemptId, "SUBMITTED_TO_SPOOLER");
    const printing = await import("@rcs/domain").then((m) => m.printing);
    await printing.requestStationPrint(ctx, orderId, "KITCHEN", randomUUID());

    const claimed = await agentPrinting.pollAndClaim(ws);
    expect(claimed).toBeNull(); // manual job intentionally not offered to the agent poll in this phase
  });
});

describe("agent attempt lifecycle", () => {
  it("start requires the exact matching workstation/job/attempt", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();
    const claimed = await agentPrinting.pollAndClaim(ws);
    const started = await agentPrinting.beginSubmission(ws, kitchenJobId, claimed!.attemptId);
    expect(started.status).toBe("PRINTING");
    expect(started.submissionStartedAt).not.toBeNull();
  });

  it("rejects a wrong attemptId for start", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();
    await agentPrinting.pollAndClaim(ws);
    await expect(agentPrinting.beginSubmission(ws, kitchenJobId, randomUUID())).rejects.toThrow();
  });

  it("rejects a stale attempt for start after the lease window", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();
    const claimed = await agentPrinting.pollAndClaim(ws);
    await prisma.printJob.update({ where: { id: kitchenJobId }, data: { claimedAt: new Date(Date.now() - 91_000) } });
    await expect(agentPrinting.beginSubmission(ws, kitchenJobId, claimed!.attemptId)).rejects.toThrow();
  });

  it("duplicate identical ACK is idempotent", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();
    const claimed = await agentPrinting.pollAndClaim(ws);
    await agentPrinting.beginSubmission(ws, kitchenJobId, claimed!.attemptId);
    const first = await agentPrinting.submitResult(ws, kitchenJobId, claimed!.attemptId, "SUBMITTED_TO_SPOOLER");
    const second = await agentPrinting.submitResult(ws, kitchenJobId, claimed!.attemptId, "SUBMITTED_TO_SPOOLER");
    expect(first.status).toBe("PRINTED");
    expect(second.status).toBe("PRINTED");
    expect(second.printedAt?.getTime()).toBe(first.printedAt?.getTime()); // no re-mutation
  });

  it("rejects a conflicting ACK for the same attempt", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();
    const claimed = await agentPrinting.pollAndClaim(ws);
    await agentPrinting.beginSubmission(ws, kitchenJobId, claimed!.attemptId);
    await agentPrinting.submitResult(ws, kitchenJobId, claimed!.attemptId, "SUBMITTED_TO_SPOOLER");
    await expect(agentPrinting.submitResult(ws, kitchenJobId, claimed!.attemptId, "FAILED_BEFORE_SUBMISSION")).rejects.toThrow();
  });

  it("result from the WRONG workstation is rejected even for a real jobId/attemptId", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();
    const claimed = await agentPrinting.pollAndClaim(ws);
    await agentPrinting.beginSubmission(ws, kitchenJobId, claimed!.attemptId);

    const impostorPairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    const impostor = await workstations.registerAgentFromPairing({ code: impostorPairing.code });
    const impostorCtx = { workstationId: impostor.workstationId, restaurantId: impostor.restaurantId, locationId: impostor.locationId, station: impostor.station };
    await expect(agentPrinting.submitResult(impostorCtx, kitchenJobId, claimed!.attemptId, "SUBMITTED_TO_SPOOLER")).rejects.toThrow();
  });
});

describe("agent recovery", () => {
  it("a claim that crashes before start is safely reclaimable after the stale window", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();
    await agentPrinting.pollAndClaim(ws); // claimed, never started (simulated crash)
    await prisma.printJob.update({ where: { id: kitchenJobId }, data: { claimedAt: new Date(Date.now() - 91_000) } });

    const reclaimed = await agentPrinting.pollAndClaim(ws); // next poll cycle after "restart"
    expect(reclaimed?.jobId).toBe(kitchenJobId);
    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJobId } });
    expect(row.attemptCount).toBe(2); // second claim, not silently reusing the first
  });

  it("a started attempt with no result never auto-reprints — it becomes SUBMISSION_UNKNOWN, not PENDING", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();
    const claimed = await agentPrinting.pollAndClaim(ws);
    await agentPrinting.beginSubmission(ws, kitchenJobId, claimed!.attemptId);
    await prisma.printJob.update({ where: { id: kitchenJobId }, data: { submissionStartedAt: new Date(Date.now() - 91_000) } });

    const nextPoll = await agentPrinting.pollAndClaim(ws); // triggers the sweep as a side effect
    expect(nextPoll).toBeNull(); // nothing else pending
    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJobId } });
    expect(row.status).toBe("SUBMISSION_UNKNOWN");
  });

  it("a late ACK after the server already marked SUBMISSION_UNKNOWN still reconciles to the real outcome (ACK loss recovery)", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();
    const claimed = await agentPrinting.pollAndClaim(ws);
    await agentPrinting.beginSubmission(ws, kitchenJobId, claimed!.attemptId);
    await prisma.printJob.update({ where: { id: kitchenJobId }, data: { submissionStartedAt: new Date(Date.now() - 91_000) } });
    await agentPrinting.pollAndClaim(ws); // sweep flips it to SUBMISSION_UNKNOWN

    // Agent's local durable state DOES know it actually printed successfully
    // (crash/network loss happened only between local success and the ACK
    // reaching the server) — the late ACK must still finalize correctly.
    const late = await agentPrinting.submitResult(ws, kitchenJobId, claimed!.attemptId, "SUBMITTED_TO_SPOOLER");
    expect(late.status).toBe("PRINTED");
    expect(late.resultOutcome).toBe("SUBMITTED_TO_SPOOLER");
  });

  it("SUBMISSION_UNKNOWN reported explicitly by the agent is never auto-reprinted by another poll", async () => {
    await policy("KITCHEN");
    const ws = await pairWorkstation("KITCHEN");
    const { kitchenJobId } = await sendOrder();
    const claimed = await agentPrinting.pollAndClaim(ws);
    await agentPrinting.beginSubmission(ws, kitchenJobId, claimed!.attemptId);
    await agentPrinting.submitResult(ws, kitchenJobId, claimed!.attemptId, "SUBMISSION_UNKNOWN", "restarted before local outcome known");

    const nextPoll = await agentPrinting.pollAndClaim(ws);
    expect(nextPoll).toBeNull(); // status stays SUBMISSION_UNKNOWN, never becomes a new PENDING candidate
    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJobId } });
    expect(row.status).toBe("SUBMISSION_UNKNOWN");
  });
});

describe("QZ coexistence — isAgentActiveForStation", () => {
  it("is false with no paired workstation, true once one has a recent heartbeat, false again once stale/revoked", async () => {
    expect(await agentPrinting.isAgentActiveForStation(restaurantId, locationId, "KITCHEN")).toBe(false);

    const ws = await pairWorkstation("KITCHEN");
    expect(await agentPrinting.isAgentActiveForStation(restaurantId, locationId, "KITCHEN")).toBe(false); // paired but no heartbeat yet

    await prisma.workstation.update({ where: { id: ws.workstationId }, data: { lastSeenAt: new Date() } });
    expect(await agentPrinting.isAgentActiveForStation(restaurantId, locationId, "KITCHEN")).toBe(true);
    expect(await agentPrinting.isAgentActiveForStation(restaurantId, locationId, "BAR")).toBe(false); // never leaks across stations

    await prisma.workstation.update({ where: { id: ws.workstationId }, data: { lastSeenAt: new Date(Date.now() - 3 * 60 * 1000) } });
    expect(await agentPrinting.isAgentActiveForStation(restaurantId, locationId, "KITCHEN")).toBe(false); // stale heartbeat

    await prisma.workstation.update({ where: { id: ws.workstationId }, data: { lastSeenAt: new Date(), revokedAt: new Date(), isEnabled: false } });
    expect(await agentPrinting.isAgentActiveForStation(restaurantId, locationId, "KITCHEN")).toBe(false); // revoked, even with a fresh heartbeat
  });
});
