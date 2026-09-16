/**
 * PRINTING V2 FINAL — the two operational printing modes (LOGIN_AWARE,
 * CENTRAL_ROUTING), deterministic CENTRAL_ROUTING multi-agent routing,
 * LOGIN_AWARE terminal binding security/lifecycle, mode switching, and the
 * RECEIPT isAutomatic physical-failure root-cause fix. See also
 * print-routes.test.ts (Printing V2 route model, unchanged/still passing)
 * and print-reprint.test.ts (receipt idempotency, unchanged/still passing).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext, WorkstationAuthContext } from "@rcs/auth";
import { orders, billing, workstations, agentPrinting, terminal } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  tableId: string;
  kitchenItemId: string;
  barItemId: string;
}

function context(fixture: Fixture, roles: string[], employeeId: string, restaurantId = fixture.restaurantId): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId,
    locationIds: [fixture.locationId],
    roles,
    permissions: new Set(["workstations.manage", "orders.print", "production.manage"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "PrintingModes tenant", slug: `printing-modes-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" } });
  const kitchenItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Cevapi", slug: `cevapi-${randomUUID()}`, price: "700.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const barItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pivo", slug: `pivo-${randomUUID()}`, price: "300.00", taxRate: "20", preparationStation: "BAR" },
  });
  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id, tableId: table.id, kitchenItemId: kitchenItem.id, barItemId: barItem.id };
}

async function pairComputer(fixture: Fixture, ownerCtx: AuthContext, name: string) {
  const pairing = await workstations.createPairing(ownerCtx, { locationId: fixture.locationId, name });
  const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
  await prisma.workstation.update({ where: { id: registered.workstationId }, data: { lastSeenAt: new Date() } });
  const wsCtx: WorkstationAuthContext = {
    workstationId: registered.workstationId,
    restaurantId: registered.restaurantId,
    locationId: registered.locationId,
    station: registered.station,
  };
  return { registered, wsCtx };
}

async function payOrder(fixture: Fixture, waiter: AuthContext) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
  const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
  return billing.completePayment(waiter, submitted.id, { method: "CASH", tenderedAmount: 2000 });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("Restaurant.printingMode defaults and mode switch", () => {
  it("defaults to CENTRAL_ROUTING — every existing restaurant's behavior is unchanged until an Admin deliberately switches", async () => {
    const fixture = await createFixture();
    expect(await workstations.getPrintingMode(context(fixture, ["OWNER"], "owner-1"))).toBe("CENTRAL_ROUTING");
  });

  it("setPrintingMode is audited and preserves pairing/routes/history across a switch and back", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered } = await pairComputer(fixture, owner, "PC1");
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });

    await workstations.setPrintingMode(owner, { printingMode: "LOGIN_AWARE" });
    expect(await workstations.getPrintingMode(owner)).toBe("LOGIN_AWARE");
    const auditEntry = await prisma.auditLog.findFirst({ where: { restaurantId: fixture.restaurantId, action: "printing.mode_changed" } });
    expect(auditEntry).not.toBeNull();
    expect((auditEntry!.previousValue as { printingMode: string }).printingMode).toBe("CENTRAL_ROUTING");
    expect((auditEntry!.newValue as { printingMode: string }).printingMode).toBe("LOGIN_AWARE");

    // Pairing, routes and print history all survive the switch untouched.
    const routes = await workstations.listPrintRoutes(owner, registered.workstationId);
    expect(routes).toHaveLength(1);
    expect(routes[0].printerName).toBe("POS-58");
    const stillPaired = await prisma.workstation.findUnique({ where: { id: registered.workstationId } });
    expect(stillPaired?.revokedAt).toBeNull();

    await workstations.setPrintingMode(owner, { printingMode: "CENTRAL_ROUTING" });
    expect(await workstations.getPrintingMode(owner)).toBe("CENTRAL_ROUTING");
    expect(await prisma.auditLog.count({ where: { restaurantId: fixture.restaurantId, action: "printing.mode_changed" } })).toBe(2);
  });

  it("rejects an unauthorized mode change", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    await expect(workstations.setPrintingMode(waiter, { printingMode: "LOGIN_AWARE" })).rejects.toThrow();
  });
});

describe("CENTRAL_ROUTING — deterministic multi-agent routing (never 'whichever Agent polls first')", () => {
  it("single workstation: the only candidate always wins, isPrimary irrelevant", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered, wsCtx } = await pairComputer(fixture, owner, "PC1");
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });

    const active = await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "KITCHEN");
    expect(active).toBe(true);
    // pollAndClaim only returns a job if it's the eligible workstation.
    await payOrder(fixture, context(fixture, ["WAITER"], "waiter-1"));
    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed?.station).toBe("KITCHEN");
  });

  it("two workstations, same route type, no explicit primary: exactly one deterministic winner (lowest workstationId), and it never changes across repeated resolution", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const a = await pairComputer(fixture, owner, "PC-A");
    const b = await pairComputer(fixture, owner, "PC-B");
    await workstations.upsertPrintRoute(owner, a.registered.workstationId, "KITCHEN", { printerName: "Printer-A", paperWidthMm: 58 });
    await workstations.upsertPrintRoute(owner, b.registered.workstationId, "KITCHEN", { printerName: "Printer-B", paperWidthMm: 58 });

    const lowestId = [a.registered.workstationId, b.registered.workstationId].sort()[0];
    const winner = lowestId === a.registered.workstationId ? a : b;
    const loser = lowestId === a.registered.workstationId ? b : a;

    // Determinism proven across several independent orders/claim cycles —
    // the SAME workstation wins every single time, never "whichever polls
    // first" (both are polled in the same order below, repeatedly).
    for (let i = 0; i < 3; i++) {
      await payOrder(fixture, context(fixture, ["WAITER"], `waiter-${i}`));
      expect(await agentPrinting.pollAndClaim(loser.wsCtx)).toBeNull();
      expect((await agentPrinting.pollAndClaim(winner.wsCtx))?.station).toBe("KITCHEN");
    }
  });

  it("an explicit isPrimary route always wins over the deterministic tie-break, and setting a new primary demotes the old one", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const a = await pairComputer(fixture, owner, "PC-A");
    const b = await pairComputer(fixture, owner, "PC-B");
    await workstations.upsertPrintRoute(owner, a.registered.workstationId, "KITCHEN", { printerName: "Printer-A", paperWidthMm: 58 });
    await workstations.upsertPrintRoute(owner, b.registered.workstationId, "KITCHEN", { printerName: "Printer-B", paperWidthMm: 58 });

    // Make B primary regardless of which workstationId happens to sort lowest.
    await workstations.upsertPrintRoute(owner, b.registered.workstationId, "KITCHEN", { isPrimary: true });
    const bRoute = (await workstations.listPrintRoutes(owner, b.registered.workstationId))[0];
    expect(bRoute.isPrimary).toBe(true);

    await payOrder(fixture, context(fixture, ["WAITER"], "waiter-1"));
    expect(await agentPrinting.pollAndClaim(a.wsCtx)).toBeNull();
    expect((await agentPrinting.pollAndClaim(b.wsCtx))?.station).toBe("KITCHEN");

    // Demote B by making A primary instead — never two simultaneous primaries.
    await workstations.upsertPrintRoute(owner, a.registered.workstationId, "KITCHEN", { isPrimary: true });
    const [aRouteAfter, bRouteAfter] = await Promise.all([
      workstations.listPrintRoutes(owner, a.registered.workstationId),
      workstations.listPrintRoutes(owner, b.registered.workstationId),
    ]);
    expect(aRouteAfter[0].isPrimary).toBe(true);
    expect(bRouteAfter[0].isPrimary).toBe(false);
  });
});

describe("LOGIN_AWARE — terminal binding drives claim eligibility", () => {
  async function loginAwareFixture() {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    await workstations.setPrintingMode(owner, { printingMode: "LOGIN_AWARE" });
    const { registered, wsCtx } = await pairComputer(fixture, owner, "PC1");
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    await workstations.upsertPrintRoute(owner, registered.workstationId, "BAR", { printerName: "POS-58", paperWidthMm: 58 });
    await workstations.upsertPrintRoute(owner, registered.workstationId, "RECEIPT", { printerName: "POS-58", paperWidthMm: 58 });
    return { fixture, owner, registered, wsCtx };
  }

  it("KITCHEN login on the paired workstation: KITCHEN eligible, BAR and RECEIPT are not", async () => {
    const { fixture, registered, wsCtx } = await loginAwareFixture();
    const kitchenCtx = context(fixture, ["KITCHEN"], "kitchen-1");
    const intent = await terminal.createTerminalBindIntent(kitchenCtx);
    expect(intent?.printRole).toBe("KITCHEN");
    await terminal.consumeTerminalBind(wsCtx, { token: intent!.token });

    await payOrder(fixture, context(fixture, ["WAITER"], "waiter-1"));
    expect((await agentPrinting.pollAndClaim(wsCtx))?.station).toBe("KITCHEN");
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "BAR")).toBe(false);
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "RECEIPT")).toBe(false);
    void registered;
  });

  it("BAR login on the SAME computer replaces KITCHEN eligibility with BAR — no re-pairing, no route change", async () => {
    const { fixture, wsCtx } = await loginAwareFixture();
    const kitchenCtx = context(fixture, ["KITCHEN"], "kitchen-1");
    await terminal.consumeTerminalBind(wsCtx, { token: (await terminal.createTerminalBindIntent(kitchenCtx))!.token });
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "KITCHEN")).toBe(true);

    const barCtx = context(fixture, ["BAR"], "bar-1");
    await terminal.consumeTerminalBind(wsCtx, { token: (await terminal.createTerminalBindIntent(barCtx))!.token });
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "KITCHEN")).toBe(false);
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "BAR")).toBe(true);
  });

  it("WAITER login grants RECEIPT eligibility only", async () => {
    const { fixture, wsCtx } = await loginAwareFixture();
    const waiterCtx = context(fixture, ["WAITER"], "waiter-1");
    await terminal.consumeTerminalBind(wsCtx, { token: (await terminal.createTerminalBindIntent(waiterCtx))!.token });
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "RECEIPT")).toBe(true);
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "KITCHEN")).toBe(false);
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "BAR")).toBe(false);
  });

  it("logout (unbindTerminalSession) removes eligibility promptly, without waiting for TTL", async () => {
    const { fixture, wsCtx } = await loginAwareFixture();
    const kitchenCtx = context(fixture, ["KITCHEN"], "kitchen-1");
    await terminal.consumeTerminalBind(wsCtx, { token: (await terminal.createTerminalBindIntent(kitchenCtx))!.token });
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "KITCHEN")).toBe(true);

    await terminal.unbindTerminalSession(kitchenCtx);
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "KITCHEN")).toBe(false);
    expect(await terminal.getTerminalStatus(kitchenCtx)).toBeNull();
  });

  it("elevated roles (OWNER/ADMIN/MANAGER/INVENTORY_MANAGER) never get an automatic operational print role", async () => {
    const fixture = await createFixture();
    for (const role of ["OWNER", "ADMIN", "MANAGER", "INVENTORY_MANAGER"]) {
      const ctx = context(fixture, [role], `${role}-1`);
      expect(await terminal.createTerminalBindIntent(ctx)).toBeNull();
    }
  });

  it("a multi-role employee resolves KITCHEN > BAR > WAITER, in that priority order", () => {
    expect(terminal.operationalPrintRoleFor(["MANAGER", "KITCHEN"])).toBe("KITCHEN");
    expect(terminal.operationalPrintRoleFor(["KITCHEN", "BAR"])).toBe("KITCHEN");
    expect(terminal.operationalPrintRoleFor(["BAR", "WAITER"])).toBe("BAR");
    expect(terminal.operationalPrintRoleFor(["WAITER"])).toBe("RECEIPT");
  });

  it("session heartbeat extends the TTL; a stale, never-heartbeated session eventually expires", async () => {
    const { fixture, wsCtx, registered } = await loginAwareFixture();
    const kitchenCtx = context(fixture, ["KITCHEN"], "kitchen-1");
    await terminal.consumeTerminalBind(wsCtx, { token: (await terminal.createTerminalBindIntent(kitchenCtx))!.token });
    expect(await terminal.heartbeatTerminalSession(kitchenCtx)).toBe(true);

    // Simulate a lapsed session (browser closed, no heartbeat) by forcing expiresAt into the past.
    await prisma.workstationTerminalSession.update({ where: { workstationId: registered.workstationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await terminal.getTerminalStatus(kitchenCtx)).toBeNull();
    expect(await agentPrinting.isAgentActiveForStation(fixture.restaurantId, fixture.locationId, "KITCHEN")).toBe(false);
    expect(await terminal.heartbeatTerminalSession(kitchenCtx)).toBe(false); // never resurrects a lapsed session
  });
});

describe("LOGIN_AWARE terminal binding — security", () => {
  it("a bind-intent minted for one restaurant is rejected by an Agent belonging to another restaurant (cross-tenant)", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    await workstations.setPrintingMode(owner, { printingMode: "LOGIN_AWARE" });
    const kitchenCtx = context(fixture, ["KITCHEN"], "kitchen-1");
    const intent = (await terminal.createTerminalBindIntent(kitchenCtx))!;

    const otherOwner = context(fixture, ["OWNER"], "other-owner-1", fixture.otherRestaurantId);
    const otherLocation = await prisma.location.create({ data: { restaurantId: fixture.otherRestaurantId, name: "Other Main" } });
    otherOwner.locationIds = [otherLocation.id];
    const otherPairing = await workstations.createPairing(otherOwner, { locationId: otherLocation.id, name: "Foreign PC" });
    const otherRegistered = await workstations.registerAgentFromPairing({ code: otherPairing.code });
    const foreignWsCtx: WorkstationAuthContext = { workstationId: otherRegistered.workstationId, restaurantId: otherRegistered.restaurantId, locationId: otherRegistered.locationId, station: otherRegistered.station };

    await expect(terminal.consumeTerminalBind(foreignWsCtx, { token: intent.token })).rejects.toThrow();
  });

  it("a token is single-use — a second consumption attempt fails even with the correct restaurant", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    await workstations.setPrintingMode(owner, { printingMode: "LOGIN_AWARE" });
    const { wsCtx } = await pairComputer(fixture, owner, "PC1");
    const kitchenCtx = context(fixture, ["KITCHEN"], "kitchen-1");
    const intent = (await terminal.createTerminalBindIntent(kitchenCtx))!;

    await terminal.consumeTerminalBind(wsCtx, { token: intent.token });
    await expect(terminal.consumeTerminalBind(wsCtx, { token: intent.token })).rejects.toThrow();
  });

  it("an invalid/garbage token is rejected", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { wsCtx } = await pairComputer(fixture, owner, "PC1");
    await expect(terminal.consumeTerminalBind(wsCtx, { token: "not-a-real-token-at-all" })).rejects.toThrow();
  });

  it("binding a second workstation for the same employee clears their first binding (one active binding per employee)", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    await workstations.setPrintingMode(owner, { printingMode: "LOGIN_AWARE" });
    const a = await pairComputer(fixture, owner, "PC-A");
    const b = await pairComputer(fixture, owner, "PC-B");
    const kitchenCtx = context(fixture, ["KITCHEN"], "kitchen-1");

    await terminal.consumeTerminalBind(a.wsCtx, { token: (await terminal.createTerminalBindIntent(kitchenCtx))!.token });
    expect((await terminal.getTerminalStatus(kitchenCtx))?.workstationId).toBe(a.registered.workstationId);

    await terminal.consumeTerminalBind(b.wsCtx, { token: (await terminal.createTerminalBindIntent(kitchenCtx))!.token });
    const status = await terminal.getTerminalStatus(kitchenCtx);
    expect(status?.workstationId).toBe(b.registered.workstationId);
    expect(await prisma.workstationTerminalSession.findUnique({ where: { workstationId: a.registered.workstationId } })).toBeNull();
  });
});

describe("RECEIPT physical-failure root cause — isAutomatic fix", () => {
  it("the automatic payment-time RECEIPT PrintJob is isAutomatic:true, so the Agent's own poll can actually find it (regression: it used to default to false, invisible to pollAndClaim forever)", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { wsCtx, registered } = await pairComputer(fixture, owner, "PC1");
    await workstations.upsertPrintRoute(owner, registered.workstationId, "RECEIPT", { printerName: "POS-58", paperWidthMm: 58 });

    const { order } = await payOrder(fixture, context(fixture, ["WAITER"], "waiter-1"));
    const job = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "RECEIPT" } });
    expect(job.isAutomatic).toBe(true);

    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed?.documentType).toBe("RECEIPT");
    expect(claimed?.jobId).toBe(job.id);
  });

  it("REGRESSION for real receipt #425: the automatic RECEIPT job's ticket content is sized for the REAL Agent route's paper width (58mm), not the legacy empty PrinterConfig default (80mm) — reproduces the exact payment -> receipt -> pollAndClaim path, not dispatchReceiptPrintJob in isolation", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    // Same restaurant shape as the real PREPROD failure: no legacy
    // Browser/QZ PrinterConfig row exists (this restaurant is fully on the
    // Printing V2 Agent/WorkstationPrintRoute model), and the real RECEIPT
    // route is configured for a 58mm roll printer (POS-58), same as test_11.
    const { wsCtx, registered } = await pairComputer(fixture, owner, "PC1");
    await workstations.upsertPrintRoute(owner, registered.workstationId, "RECEIPT", { printerName: "POS-58", paperWidthMm: 58 });

    const { order } = await payOrder(fixture, context(fixture, ["WAITER"], "waiter-1"));
    const job = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "RECEIPT" } });

    // The bug: dispatchReceiptPrintJob unconditionally read the legacy
    // PrinterConfig default (80mm) instead of the real Agent route (58mm),
    // freezing the wrong width into the ticket content forever. This is the
    // exact numeric divergence that made real receipt #425 fail physically
    // ("Driver printable area is too small for this ticket.") even though
    // the job was correctly automatic and correctly claimable.
    const content = job.content as unknown as { paperWidthMm: number };
    expect(content.paperWidthMm).toBe(58);
    expect(content.paperWidthMm).not.toBe(80);

    // And the full real path still works end to end: the job is Agent-
    // eligible, atomically claimable by the eligible workstation...
    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed?.documentType).toBe("RECEIPT");
    expect(claimed?.jobId).toBe(job.id);

    // ...and NOT claimable by an unrelated, ineligible Agent (a second
    // workstation with no RECEIPT route configured at all).
    const other = await pairComputer(fixture, owner, "PC2");
    const { order: order2 } = await payOrder(fixture, context(fixture, ["WAITER"], "waiter-2"));
    const job2 = await prisma.printJob.findFirstOrThrow({ where: { orderId: order2.id, type: "RECEIPT" } });
    expect((job2.content as unknown as { paperWidthMm: number }).paperWidthMm).toBe(58);
    expect(await agentPrinting.pollAndClaim(other.wsCtx)).toBeNull();
  });

  it("REGRESSION for #425: when NO Agent is active for RECEIPT at all, dispatch still falls back to the legacy PrinterConfig default (80mm) unchanged — the fix only reorders preference, it never removes the fallback", async () => {
    const fixture = await createFixture();
    const { order } = await payOrder(fixture, context(fixture, ["WAITER"], "waiter-1"));
    const job = await prisma.printJob.findFirstOrThrow({ where: { orderId: order.id, type: "RECEIPT" } });
    expect((job.content as unknown as { paperWidthMm: number }).paperWidthMm).toBe(80);
  });
});
