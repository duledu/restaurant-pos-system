// Printing Architecture V2 — ONE computer / ONE Print Agent / MULTIPLE
// print routes (KITCHEN/BAR/RECEIPT), the same physical printer reusable
// across all of them. These tests cover the genuinely NEW behavior that
// the pre-existing single-station workstation tests (print-auto-dispatch,
// workstation-*.test.ts) cannot exercise: multiple routes on one agent,
// RECEIPT finally reachable through the Agent path, route independence,
// and tenant isolation on route mutations. See also print-auto-dispatch's
// stationPrinterStatus/pollAndClaim suites for the still-passing
// single-route/backward-compat coverage.
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext, WorkstationAuthContext } from "@rcs/auth";
import { orders, billing, printing, workstations, agentPrinting } from "@rcs/domain";
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
  // Same role-aware permission split as printing-modes.test.ts (mirror
  // production RBAC). Floor roles (WAITER/KITCHEN/BAR) get only
  // orders.print / production permissions; management roles get
  // workstations.manage + settings.manage. Previously the fixture
  // granted workstations.manage to every role, which would hide any
  // real authorization regression in the RECEIPT poll/claim path.
  const isManagement = roles.some((r) => r === "OWNER" || r === "MANAGER" || r === "ADMIN");
  const permissions = new Set<string>(["orders.print", "production.view", "production.manage"]);
  if (isManagement) {
    permissions.add("workstations.manage");
    permissions.add("settings.manage");
  }
  return {
    userId: employeeId,
    employeeId,
    restaurantId,
    locationIds: [fixture.locationId],
    roles,
    permissions,
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "PrintRoutes tenant", slug: `print-routes-${randomUUID()}` } });
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

/** Pairs a computer with NO station (the new Admin flow) and returns a
 * ready-to-use WorkstationAuthContext, mirroring what registerAgentFromPairing
 * + a live heartbeat would produce. */
async function pairComputer(fixture: Fixture, ownerCtx: AuthContext) {
  const pairing = await workstations.createPairing(ownerCtx, { locationId: fixture.locationId, name: "Kuhinja_new_test" });
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

async function submitMixedOrder(fixture: Fixture, waiter: AuthContext) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.barItemId, quantity: 1 });
  return orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("Printing V2 — one Agent, multiple print routes sharing one printer", () => {
  it("pairing creates zero routes; Admin configures KITCHEN, BAR and RECEIPT afterward, all pointed at the same physical printer", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered, wsCtx } = await pairComputer(fixture, owner);

    expect(await workstations.listPrintRoutes(owner, registered.workstationId)).toHaveLength(0);
    expect(await agentPrinting.pollAndClaim(wsCtx)).toBeNull(); // nothing claimable yet — no routes at all

    for (const type of ["KITCHEN", "BAR", "RECEIPT"] as const) {
      await workstations.upsertPrintRoute(owner, registered.workstationId, type, { printerName: "POS-58", paperWidthMm: 58 });
    }
    // Same printer reused across all three routes with no conflict.
    const routes = await workstations.listPrintRoutes(owner, registered.workstationId);
    expect(routes).toHaveLength(3);
    expect(routes.every((r) => r.printerName === "POS-58")).toBe(true);
  });

  it("one Agent with KITCHEN+BAR routes claims both stations' tickets from the SAME mixed order, in one poll loop", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered, wsCtx } = await pairComputer(fixture, owner);
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    await workstations.upsertPrintRoute(owner, registered.workstationId, "BAR", { printerName: "POS-58", paperWidthMm: 58 });
    await prisma.workstationPrintRoute.updateMany({ where: { workstationId: registered.workstationId }, data: { printerAvailable: true } });

    const waiter = context(fixture, ["WAITER"], "waiter-1");
    await submitMixedOrder(fixture, waiter);

    const first = await agentPrinting.pollAndClaim(wsCtx);
    const second = await agentPrinting.pollAndClaim(wsCtx);
    expect([first?.station, second?.station].sort()).toEqual(["BAR", "KITCHEN"]);
    // No third job to claim — the same agent doesn't double-claim.
    expect(await agentPrinting.pollAndClaim(wsCtx)).toBeNull();
  });

  it("RECEIPT is finally reachable through the Agent path — a real payment's receipt PrintJob is pollable/claimable by a workstation with a RECEIPT route", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered, wsCtx } = await pairComputer(fixture, owner);
    await workstations.upsertPrintRoute(owner, registered.workstationId, "RECEIPT", { printerName: "POS-58", paperWidthMm: 58 });
    await prisma.workstationPrintRoute.updateMany({ where: { workstationId: registered.workstationId }, data: { printerAvailable: true } });

    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiter, submitted.id, { method: "CASH", tenderedAmount: 2000 });

    const claimed = await agentPrinting.pollAndClaim(wsCtx);
    expect(claimed).not.toBeNull();
    expect(claimed?.documentType).toBe("RECEIPT");

    // The full Print Agent flow is claim -> startSubmission -> submitResult.
    // Tests in agent-print-delivery.test.ts that target KITCHEN/BAR call
    // beginSubmission between these two; this RECEIPT-specific test was
    // written before the 3-step flow was the only valid path and called
    // submitResult directly, which trips the "Submission was not started"
    // guard in confirmPrintResult. Add the missing step here (no
    // production behavior is changed — the guard and the helper already
    // exist and are used by every other Agent claim path).
    await agentPrinting.beginSubmission(wsCtx, claimed!.jobId, claimed!.attemptId);

    // Confirming the outcome flows through the same PrintJob state machine
    // as KITCHEN/BAR — no separate RECEIPT lifecycle was invented.
    const result = await agentPrinting.submitResult(wsCtx, claimed!.jobId, claimed!.attemptId, "SUBMITTED_TO_SPOOLER");
    expect(result.status).toBe("PRINTED");
  });

  it("disabling the BAR route never affects KITCHEN readiness on the same workstation (route independence)", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered } = await pairComputer(fixture, owner);
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    await workstations.upsertPrintRoute(owner, registered.workstationId, "BAR", { printerName: "POS-58", paperWidthMm: 58 });
    await prisma.workstationPrintRoute.updateMany({ where: { workstationId: registered.workstationId }, data: { printerAvailable: true } });

    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("READY");
    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "BAR")).state).toBe("READY");

    await workstations.upsertPrintRoute(owner, registered.workstationId, "BAR", { isEnabled: false });

    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "BAR")).state).toBe("NOT_CONFIGURED");
    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("READY");
  });

  it("changing a route's printer resets its reported availability to unknown until the agent re-confirms (never assumed available)", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered } = await pairComputer(fixture, owner);
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    await prisma.workstationPrintRoute.updateMany({ where: { workstationId: registered.workstationId, type: "KITCHEN" }, data: { printerAvailable: true } });
    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("READY");

    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "EPSON-NEW" });
    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("PRINTER_UNAVAILABLE");
  });

  it("two independent Agents on the same location each own their own routes — one Agent's routes never leak into another's poll", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const agentA = await pairComputer(fixture, owner);
    const agentB = await pairComputer(fixture, owner);
    await workstations.upsertPrintRoute(owner, agentA.registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    await prisma.workstationPrintRoute.updateMany({ where: { workstationId: agentA.registered.workstationId }, data: { printerAvailable: true } });
    // Agent B has NO routes configured at all.

    const waiter = context(fixture, ["WAITER"], "waiter-1");
    await submitMixedOrder(fixture, waiter);

    expect(await agentPrinting.pollAndClaim(agentB.wsCtx)).toBeNull();
    const claimedByA = await agentPrinting.pollAndClaim(agentA.wsCtx);
    expect(claimedByA?.station).toBe("KITCHEN");
  });

  it("tenant isolation: an Admin cannot list or upsert print routes on another restaurant's workstation", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered } = await pairComputer(fixture, owner);

    const foreignAdmin = context(fixture, ["OWNER"], "foreign-owner", fixture.otherRestaurantId);
    await expect(workstations.listPrintRoutes(foreignAdmin, registered.workstationId)).rejects.toThrow();
    await expect(
      workstations.upsertPrintRoute(foreignAdmin, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 })
    ).rejects.toThrow();

    // Confirm nothing was created despite the rejected attempt.
    expect(await workstations.listPrintRoutes(owner, registered.workstationId)).toHaveLength(0);
  });

  it("route mutations are audited with old/new printer values", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered } = await pairComputer(fixture, owner);

    const created = await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    const createdEntry = await prisma.auditLog.findFirst({ where: { entityId: created.id, action: "workstation.route_updated" }, orderBy: { createdAt: "desc" } });
    expect(createdEntry).not.toBeNull();
    expect((createdEntry!.newValue as { printerName: string }).printerName).toBe("POS-58");

    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "EPSON-NEW", paperWidthMm: 58 });
    const updatedEntry = await prisma.auditLog.findFirst({ where: { entityId: created.id, action: "workstation.route_updated" }, orderBy: { createdAt: "desc" } });
    expect((updatedEntry!.previousValue as { printerName: string }).printerName).toBe("POS-58");
    expect((updatedEntry!.newValue as { printerName: string }).printerName).toBe("EPSON-NEW");
  });

  it("legacy single-station pairing shortcut still works: station given at pairing time pre-provisions exactly that one route, unconfigured", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const pairing = await workstations.createPairing(owner, { locationId: fixture.locationId, station: "KITCHEN" });
    const registered = await workstations.registerAgentFromPairing({ code: pairing.code });

    const routes = await workstations.listPrintRoutes(owner, registered.workstationId);
    expect(routes).toHaveLength(1);
    expect(routes[0].type).toBe("KITCHEN");
    expect(routes[0].printerName).toBeNull(); // not configured yet — Admin still has to pick a printer
  });
});

// Physical PREPROD QA (pilot.5, test_11) — POS-58 was reported in
// availablePrinters, selectable in Admin, and physically printing, yet all
// three routes showed a hard red "Štampač nedostupan". Root cause: (1) every
// "Sačuvaj rute" save unconditionally resent printerName for all routes,
// resetting printerAvailable to null (unconfirmed) even when the printer
// never changed, and (2) stationPrinterStatus/routeReadiness treated
// printerAvailable===null identically to printerAvailable===false — a
// deliberate, agent-proven "not there" verdict is NOT the same thing as
// "not yet reconfirmed since the last save". These tests pin the fix: null
// now falls back to the workstation's freshest availablePrinters report
// (updated on every heartbeat, never reset by a route save) instead of a
// false negative, while a genuine, agent-proven printerAvailable===false
// still reports unavailable exactly as before.
describe("Printing V2 — printer availability status (false-\"Štampač nedostupan\" regression)", () => {
  it("availablePrinters=[POS-58] + route.printerName=POS-58 + unconfirmed (null) => READY, not PRINTER_UNAVAILABLE", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered } = await pairComputer(fixture, owner);
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    await prisma.workstation.update({ where: { id: registered.workstationId }, data: { availablePrinters: ["POS-58"], printersReportedAt: new Date() } });

    const route = await prisma.workstationPrintRoute.findFirst({ where: { workstationId: registered.workstationId, type: "KITCHEN" } });
    expect(route!.printerAvailable).toBeNull(); // never confirmed by a heartbeat yet — this is the exact bug state

    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("READY");
  });

  it("one printer serving KITCHEN+BAR+RECEIPT: all three read READY from availablePrinters alone, unconfirmed", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered } = await pairComputer(fixture, owner);
    for (const type of ["KITCHEN", "BAR", "RECEIPT"] as const) {
      await workstations.upsertPrintRoute(owner, registered.workstationId, type, { printerName: "POS-58", paperWidthMm: 58 });
    }
    await prisma.workstation.update({
      where: { id: registered.workstationId },
      data: { availablePrinters: ["POS-58", "Microsoft Print to PDF"], printersReportedAt: new Date() },
    });

    for (const type of ["KITCHEN", "BAR", "RECEIPT"] as const) {
      expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, type)).state).toBe("READY");
    }
  });

  it("availablePrinters does not contain the configured printer, unconfirmed (null) => PRINTER_UNAVAILABLE", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered } = await pairComputer(fixture, owner);
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    await prisma.workstation.update({ where: { id: registered.workstationId }, data: { availablePrinters: ["Microsoft Print to PDF"], printersReportedAt: new Date() } });

    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("PRINTER_UNAVAILABLE");
  });

  it("POS-58 disappears on a later heartbeat (agent-proven false) => READY flips to PRINTER_UNAVAILABLE, even though nothing was re-saved", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered, wsCtx } = await pairComputer(fixture, owner);
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    await workstations.recordHeartbeat(wsCtx, { availablePrinters: ["POS-58"], routes: [{ type: "KITCHEN", printerAvailable: true }] });
    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("READY");

    // Printer physically unplugged/uninstalled — the next heartbeat reports it gone.
    await workstations.recordHeartbeat(wsCtx, { availablePrinters: [], routes: [{ type: "KITCHEN", printerAvailable: false }] });
    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("PRINTER_UNAVAILABLE");
  });

  it("POS-58 returns on a later heartbeat => PRINTER_UNAVAILABLE flips back to READY automatically, no manual route re-save", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered, wsCtx } = await pairComputer(fixture, owner);
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    await workstations.recordHeartbeat(wsCtx, { availablePrinters: [], routes: [{ type: "KITCHEN", printerAvailable: false }] });
    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("PRINTER_UNAVAILABLE");

    await workstations.recordHeartbeat(wsCtx, { availablePrinters: ["POS-58"], routes: [{ type: "KITCHEN", printerAvailable: true }] });
    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("READY");
  });

  it("re-saving a route's paperWidthMm alone (printer unchanged) does not reset a confirmed-available printer to unavailable", async () => {
    const fixture = await createFixture();
    const owner = context(fixture, ["OWNER"], "owner-1");
    const { registered, wsCtx } = await pairComputer(fixture, owner);
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
    await workstations.recordHeartbeat(wsCtx, { availablePrinters: ["POS-58"], routes: [{ type: "KITCHEN", printerAvailable: true }] });
    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("READY");

    // Admin's "Sačuvaj rute" always resends printerName even when unchanged — this must be a no-op for availability.
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 80 });
    const route = await prisma.workstationPrintRoute.findFirst({ where: { workstationId: registered.workstationId, type: "KITCHEN" } });
    expect(route!.printerAvailable).toBe(true); // NOT reset to null — printer name did not actually change
    expect((await agentPrinting.stationPrinterStatus(fixture.restaurantId, fixture.locationId, "KITCHEN")).state).toBe("READY");

    // Actually changing the printer still correctly resets to unconfirmed (existing behavior, unchanged).
    await workstations.upsertPrintRoute(owner, registered.workstationId, "KITCHEN", { printerName: "EPSON-NEW" });
    const changed = await prisma.workstationPrintRoute.findFirst({ where: { workstationId: registered.workstationId, type: "KITCHEN" } });
    expect(changed!.printerAvailable).toBeNull();
  });
});
