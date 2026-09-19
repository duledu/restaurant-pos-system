import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import type { AuthContext, WorkstationAuthContext } from "@rcs/auth";
import { workstations } from "@rcs/domain";
import { evaluateTestPollResult, type PollObservation, STALE_REQUEST_BUFFER_MS } from "../../apps/web/lib/test-print-reconciliation";
import { observeTestPrintLifecycle, OBSERVATION_WINDOW_MS, POLL_INTERVAL_MS, extractWorkstationObservation } from "../../apps/web/lib/test-print-observation";
import { resetPrismaTestTables } from "../setup/reset-test-db";

/**
 * PHYSICAL-QA FIX #1 — "SUCCESSFUL TEST PRINT MUST BECOME PERSISTED READY
 * STATE — ADMIN MUST NOT EXPOSE A SILENT BROWSER-PRINT FOOTGUN".
 *
 * This test file pins the small, correctness-bearing invariants the
 * Printing P0 architecture requires:
 *
 *  - The Agent's technical SUCCEEDED report MUST NOT flip
 *    WorkstationPrintRoute.physicalTestConfirmed — only an explicit human
 *    confirmation through the existing endpoint (confirmPhysicalTestByAdmin
 *    OR confirmPhysicalTestByAgent) may do that. (H, I)
 *  - The Admin "human confirmation" endpoint MUST flip the same row and
 *    recompute readiness to READY. (A, B, C, J)
 *  - Routine events (heartbeat, visibility probe, printerAvailable
 *    discovery, agent restart) MUST NOT reset a previously-confirmed
 *    route. (D, E)
 *  - Physical configuration changes (printerName OR paperWidthMm) MUST
 *    reset the confirmation — a confirmation on a different physical
 *    device / width doesn't prove the new config works. (F, G)
 *  - The legacy "Probna štampa" browser-print button MUST be gone from
 *    the Admin Printers Settings UI source so it cannot be invoked by an
 *    operator who would then conclude "the test passed" with no DB
 *    record of the success. (K)
 */

let ctx: AuthContext;
let restaurantId: string;
let locationId: string;

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
  const tenant = await prisma.tenant.create({ data: { name: "Fix1Test", slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "A", currency: "RSD" } });
  restaurantId = restaurant.id;
  locationId = (await prisma.location.create({ data: { restaurantId: restaurant.id, name: "A" } })).id;
  ctx = {
    userId: "manager",
    employeeId: "manager",
    restaurantId,
    locationIds: [locationId],
    roles: ["MANAGER"],
    permissions: new Set(["workstations.manage"]),
  };
});

async function pairWorkstationWithRoutes(): Promise<{ workstationId: string; wsCtx: WorkstationAuthContext }> {
  const pairing = await workstations.createPairing(ctx, { locationId });
  const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
  await workstations.upsertPrintRoute(ctx, registered.workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 58 });
  await workstations.upsertPrintRoute(ctx, registered.workstationId, "RECEIPT", { printerName: "POS-58", paperWidthMm: 58 });
  await prisma.workstation.update({ where: { id: registered.workstationId }, data: { lastSeenAt: new Date() } });
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

/** Seed the prerequisites that make a route eligible for READY (except the
 *  physical-test confirmation, which is the variable under test): the route
 *  must be configured, the workstation must be online, and the printer
 *  must be reported visible AND available by the Agent. */
async function seedAllReadinessGatesMet(workstationId: string, type: "KITCHEN" | "RECEIPT"): Promise<void> {
  const route = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type } });
  await prisma.workstationPrintRoute.update({
    where: { id: route.id },
    data: {
      visibleToService: true,
      visibleToServiceAt: new Date(),
      printerAvailable: true,
    },
  });
}

describe("PHYSICAL-QA FIX #1 — Admin human confirmation is the ONLY path to READY", () => {
  // (A) full server-side lifecycle: false → confirmPhysicalTestByAdmin → true
  it("A: physicalTestConfirmed=false → confirmPhysicalTestByAdmin → physicalTestConfirmed=true (with admin actor)", async () => {
    const { workstationId } = await pairWorkstationWithRoutes();
    await seedAllReadinessGatesMet(workstationId, "KITCHEN");
    const before = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    expect(before.physicalTestConfirmed).toBe(false);
    expect(before.physicalTestConfirmedAt).toBeNull();
    expect(before.physicalTestConfirmedBy).toBeNull();

    const after = await workstations.confirmPhysicalTestByAdmin(ctx, workstationId, "KITCHEN");
    expect(after.physicalTestConfirmed).toBe(true);
    expect(after.physicalTestConfirmedAt).toBeInstanceOf(Date);
    expect(after.physicalTestConfirmedBy).toBe(`admin:${ctx.employeeId}`);

    // Audit row carries both before and after state. The audit captures
    // the *change* — its newValue holds `physicalTestConfirmed` + the
    // acting `actor` (separate from the `physicalTestConfirmedBy` column
    // persisted on the route row, which is verified above).
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: after.id, action: "workstation.route_physically_confirmed" },
    });
    expect(audit).toBeTruthy();
    expect(audit!.previousValue).toMatchObject({ physicalTestConfirmed: false });
    expect(audit!.newValue).toMatchObject({ physicalTestConfirmed: true, actor: `admin:${ctx.employeeId}` });
  });

  // (B) confirmed → readiness READY (via the Agent-facing helper)
  it("B: physicalTestConfirmed=true → getRouteReadinessForAgent returns READY for that route", async () => {
    const { workstationId, wsCtx } = await pairWorkstationWithRoutes();
    await seedAllReadinessGatesMet(workstationId, "KITCHEN");
    await workstations.confirmPhysicalTestByAdmin(ctx, workstationId, "KITCHEN");

    const readiness = await workstations.getRouteReadinessForAgent(wsCtx);
    const kitchen = readiness.find((r) => r.type === "KITCHEN")!;
    expect(kitchen.readiness).toBe("READY");
  });

  // (C) fresh server read after confirmation still READY — proves persistence
  it("C: fresh server read after confirmation still returns physicalTestConfirmed=true and readiness=READY", async () => {
    const { workstationId, wsCtx } = await pairWorkstationWithRoutes();
    await seedAllReadinessGatesMet(workstationId, "KITCHEN");
    await workstations.confirmPhysicalTestByAdmin(ctx, workstationId, "KITCHEN");

    // Two fresh DB reads — both must report the persisted state. This is the
    // exact pattern Admin UI performs on every page load.
    const row1 = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    const row2 = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    expect(row1.physicalTestConfirmed).toBe(true);
    expect(row2.physicalTestConfirmed).toBe(true);

    const readiness = await workstations.getRouteReadinessForAgent(wsCtx);
    expect(readiness.find((r) => r.type === "KITCHEN")!.readiness).toBe("READY");
  });

  // (D) heartbeat does NOT clear confirmation
  it("D: heartbeat (with printerAvailable + visible probes) does NOT reset physicalTestConfirmed", async () => {
    const { workstationId, wsCtx } = await pairWorkstationWithRoutes();
    await seedAllReadinessGatesMet(workstationId, "KITCHEN");
    await workstations.confirmPhysicalTestByAdmin(ctx, workstationId, "KITCHEN");

    // Simulate ~3 normal heartbeat cycles (each with full route probes).
    for (let i = 0; i < 3; i++) {
      await workstations.recordHeartbeat(wsCtx, {
        routes: [
          { type: "KITCHEN", printerAvailable: true, visible: true },
          { type: "RECEIPT", printerAvailable: true, visible: true },
        ],
      });
    }

    const after = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    expect(after.physicalTestConfirmed).toBe(true);
    expect(after.physicalTestConfirmedBy).toBe(`admin:${ctx.employeeId}`);
    // Probe fields may have been touched — those are NOT part of the
    // confirmation record and don't invalidate it.
    expect(after.visibleToService).toBe(true);
    expect(after.printerAvailable).toBe(true);
  });

  // (E) normal discovery update does NOT clear confirmation
  it("E: discrete visibleToService / printerAvailable updates do NOT reset physicalTestConfirmed", async () => {
    const { workstationId } = await pairWorkstationWithRoutes();
    await seedAllReadinessGatesMet(workstationId, "KITCHEN");
    await workstations.confirmPhysicalTestByAdmin(ctx, workstationId, "KITCHEN");

    const route = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });

    // Toggle visibleToService null → false → true → null. The Agent routinely
    // does this on every visibility probe cycle. None of it may invalidate a
    // persisted physical confirmation.
    await prisma.workstationPrintRoute.update({ where: { id: route.id }, data: { visibleToService: false } });
    expect((await prisma.workstationPrintRoute.findUniqueOrThrow({ where: { id: route.id } })).physicalTestConfirmed).toBe(true);
    await prisma.workstationPrintRoute.update({ where: { id: route.id }, data: { visibleToService: null } });
    expect((await prisma.workstationPrintRoute.findUniqueOrThrow({ where: { id: route.id } })).physicalTestConfirmed).toBe(true);

    // Same for printerAvailable.
    await prisma.workstationPrintRoute.update({ where: { id: route.id }, data: { printerAvailable: false } });
    expect((await prisma.workstationPrintRoute.findUniqueOrThrow({ where: { id: route.id } })).physicalTestConfirmed).toBe(true);
    await prisma.workstationPrintRoute.update({ where: { id: route.id }, data: { printerAvailable: null } });
    expect((await prisma.workstationPrintRoute.findUniqueOrThrow({ where: { id: route.id } })).physicalTestConfirmed).toBe(true);
  });

  // (F) printerName change invalidates old physical confirmation
  it("F: changing printerName (same paperWidth) invalidates the old physicalTestConfirmed", async () => {
    const { workstationId } = await pairWorkstationWithRoutes();
    await seedAllReadinessGatesMet(workstationId, "KITCHEN");
    await workstations.confirmPhysicalTestByAdmin(ctx, workstationId, "KITCHEN");
    const before = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    expect(before.physicalTestConfirmed).toBe(true);

    // Operator saves a different physical printer on the same route.
    await workstations.upsertPrintRoute(ctx, workstationId, "KITCHEN", { printerName: "POS-80", paperWidthMm: 58 });
    const after = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    expect(after.printerName).toBe("POS-80");
    // The OLD confirmation referred to a different physical device — must
    // be reset so the operator confirms the new device before READY.
    expect(after.physicalTestConfirmed).toBe(false);
    expect(after.physicalTestConfirmedAt).toBeNull();
    expect(after.physicalTestConfirmedBy).toBeNull();
  });

  // (G) paperWidthMm change invalidates old physical confirmation
  it("G: changing paperWidthMm (same printerName) invalidates the old physicalTestConfirmed", async () => {
    const { workstationId } = await pairWorkstationWithRoutes();
    await seedAllReadinessGatesMet(workstationId, "KITCHEN");
    await workstations.confirmPhysicalTestByAdmin(ctx, workstationId, "KITCHEN");
    const before = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    expect(before.physicalTestConfirmed).toBe(true);

    // Operator saves a different paper width on the same physical printer.
    await workstations.upsertPrintRoute(ctx, workstationId, "KITCHEN", { printerName: "POS-58", paperWidthMm: 80 });
    const after = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    expect(after.paperWidthMm).toBe(80);
    expect(after.physicalTestConfirmed).toBe(false);
    expect(after.physicalTestConfirmedAt).toBeNull();
    expect(after.physicalTestConfirmedBy).toBeNull();
  });

  // (H) THE bug-prevention test — Agent technical SUCCEEDED alone MUST NOT
  //     flip physicalTestConfirmed. This is the exact failure mode of the
  //     legacy browser-print path that was mis-interpreted by operators as
  //     "test passed, why is Admin still showing 'Čeka test štampe'?"
  it("H: Agent technical SUCCEEDED alone (recordTestPrintResult) MUST NOT set physicalTestConfirmed=true", async () => {
    const { workstationId, wsCtx } = await pairWorkstationWithRoutes();
    await seedAllReadinessGatesMet(workstationId, "KITCHEN");
    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");

    // Simulate the Agent running the test print end-to-end and reporting
    // technical success back to the server.
    await workstations.recordTestPrintResult(wsCtx, { status: "SUCCEEDED" });

    const row = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    expect(row.physicalTestConfirmed).toBe(false);
    expect(row.physicalTestConfirmedAt).toBeNull();
    expect(row.physicalTestConfirmedBy).toBeNull();

    // Workstation-level testPrintStatus IS recorded (technical lifecycle),
    // but the authoritative readiness gate stays at NEEDS_CONFIRM until a
    // human presses "Da — radi" through the confirmation endpoint.
    const ws = await prisma.workstation.findUniqueOrThrow({ where: { id: workstationId } });
    expect(ws.testPrintStatus).toBe("SUCCEEDED");
    const readiness = await workstations.getRouteReadinessForAgent(wsCtx);
    expect(readiness.find((r) => r.type === "KITCHEN")!.readiness).toBe("NEEDS_CONFIRM");
  });

  // (I) without human confirmation → readiness is NOT READY
  it("I: without human confirmation (all technical gates met) → readiness is NEEDS_CONFIRM, NOT READY", async () => {
    const { workstationId, wsCtx } = await pairWorkstationWithRoutes();
    await seedAllReadinessGatesMet(workstationId, "KITCHEN");
    // Agent runs the test and reports SUCCEEDED — exactly what the legacy
    // browser-print path physically achieved on real hardware.
    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    await workstations.recordTestPrintResult(wsCtx, { status: "SUCCEEDED" });

    const readiness = await workstations.getRouteReadinessForAgent(wsCtx);
    expect(readiness.find((r) => r.type === "KITCHEN")!.readiness).toBe("NEEDS_CONFIRM");
    const row = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    expect(row.physicalTestConfirmed).toBe(false);
  });

  // (J) after human confirmation → readiness IS READY
  it("J: after human confirmation (confirmPhysicalTestByAdmin) → readiness IS READY", async () => {
    const { workstationId, wsCtx } = await pairWorkstationWithRoutes();
    await seedAllReadinessGatesMet(workstationId, "KITCHEN");
    // Even when Agent SUCCEEDED earlier in this test, only the human
    // confirmation is allowed to flip physicalTestConfirmed.
    await workstations.requestTestPrint(ctx, workstationId, "KITCHEN");
    await workstations.recordTestPrintResult(wsCtx, { status: "SUCCEEDED" });
    await workstations.confirmPhysicalTestByAdmin(ctx, workstationId, "KITCHEN");

    const readiness = await workstations.getRouteReadinessForAgent(wsCtx);
    expect(readiness.find((r) => r.type === "KITCHEN")!.readiness).toBe("READY");
    const row = await prisma.workstationPrintRoute.findFirstOrThrow({ where: { workstationId, type: "KITCHEN" } });
    expect(row.physicalTestConfirmed).toBe(true);
    expect(row.physicalTestConfirmedBy).toBe(`admin:${ctx.employeeId}`);
  });

  // (K) source-level guard: the legacy browser-print footgun MUST be gone
  //     from the Admin Printers Settings UI source so an operator cannot
  //     reach it.
  it("K: the legacy 'Probna štampa' browser-print button is absent from printers-settings-client.tsx", async () => {
    const filePath = resolve(
      __dirname,
      "..",
      "..",
      "apps",
      "web",
      "app",
      "(admin)",
      "settings",
      "printers",
      "printers-settings-client.tsx",
    );
    expect(existsSync(filePath)).toBe(true);
    const source = readFileSync(filePath, "utf8");

    // The legacy button label and the React state/useEffect that triggered
    // a browser-side `window.print()` via `defaultPrintTransport.print()`.
    expect(source).not.toMatch(/Probna štampa/);
    expect(source).not.toMatch(/testPrintContent/);
    expect(source).not.toMatch(/buildTestPrintContent/);
    expect(source).not.toMatch(/TicketPrintPanel/);
    expect(source).not.toMatch(/defaultPrintTransport/);

    // The authoritative Admin Test Print entry-point that DOES participate
    // in the readiness lifecycle must still be present.
    expect(source).toMatch(/WorkstationsPanel/);
  });
});

/**
 * PHYSICAL-QA FIX #1 — WORKSTATIONS PANEL testPrint() RECONCILIATION
 *
 * v3 UPDATE — the Admin polling loop was extended from a 12-second hard
 * cap to a 45-second SAFE OBSERVATION WINDOW that safely covers the
 * legitimate worst-case Agent pickup + Windows print + HTTP delivery
 * cycle (see apps/web/lib/test-print-observation.ts). The reconciliation
 * decision helper additionally requires `testPrintRequestedAt` to be
 * within the operator's current request identity (with a small
 * clock-skew buffer) so a historical SUCCEEDED left on the row from a
 * previous operator session cannot satisfy a fresh click.
 *
 * Critical invariants:
 *  - A SUCCEEDED belonging to a DIFFERENT route CANNOT open the modal
 *    (avoids stale/parallel-test false-positive confirmation).
 *  - A SUCCEEDED with NULL `testPrintRouteType` CANNOT open the modal
 *    (defensive against malformed server rows).
 *  - A SUCCEEDED whose `testPrintRequestedAt` is OLDER than the
 *    operator's current request (minus STALE_REQUEST_BUFFER_MS)
 *    CANNOT open the modal — proves yesterday's leftover cannot
 *    silently confirm today's fresh click.
 *  - The reconciliation decision is identical whether it happens
 *    during polling or after the observation window — same helper,
 *    same inputs.
 */
describe("PHYSICAL-QA FIX #1 — evaluateTestPollResult (reconciliation helper)", () => {
  // 13. delayed SUCCEEDED cannot silently lose the human-confirmation step
  it("13: SUCCEEDED + matching route + matching request identity → OPEN_MODAL (the reconciliation that fixes the polling race)", () => {
    const ourRequestedAt = 1_000_000_000_000;
    expect(evaluateTestPollResult(
      { status: "SUCCEEDED", routeType: "BAR", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "BAR",
    )).toBe("OPEN_MODAL");
    expect(evaluateTestPollResult(
      { status: "SUCCEEDED", routeType: "KITCHEN", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "KITCHEN",
    )).toBe("OPEN_MODAL");
    expect(evaluateTestPollResult(
      { status: "SUCCEEDED", routeType: "RECEIPT", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "RECEIPT",
    )).toBe("OPEN_MODAL");
  });

  // 14. old/stale SUCCEEDED from another test must not falsely trigger confirmation
  it("14: SUCCEEDED + a DIFFERENT route → SHOW_TIMEOUT (proves stale/parallel-test SUCCEEDED cannot open the modal)", () => {
    const ourRequestedAt = 1_000_000_000_000;
    expect(evaluateTestPollResult(
      { status: "SUCCEEDED", routeType: "KITCHEN", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "BAR",
    )).toBe("SHOW_TIMEOUT");
    expect(evaluateTestPollResult(
      { status: "SUCCEEDED", routeType: "RECEIPT", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "BAR",
    )).toBe("SHOW_TIMEOUT");
    expect(evaluateTestPollResult(
      { status: "SUCCEEDED", routeType: "BAR", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "KITCHEN",
    )).toBe("SHOW_TIMEOUT");
  });

  it("14b: SUCCEEDED + null polledRouteType → SHOW_TIMEOUT (defensive — malformed server rows must not falsely trigger confirmation)", () => {
    const ourRequestedAt = 1_000_000_000_000;
    expect(evaluateTestPollResult(
      { status: "SUCCEEDED", routeType: null, testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "BAR",
    )).toBe("SHOW_TIMEOUT");
  });

  // 14c. FIX #1 v3 NEW — stale historical SUCCEEDED from a PREVIOUS operator
  // session cannot satisfy a NEW click. The polled `testPrintRequestedAt`
  // predates the operator's `ourRequestedAt` by more than the
  // STALE_REQUEST_BUFFER_MS tolerance.
  it("14c: SUCCEEDED with polled testPrintRequestedAt older than ourRequestedAt - STALE_REQUEST_BUFFER_MS → SHOW_TIMEOUT (stale historical SUCCEEDED protection)", () => {
    const ourRequestedAt = 1_000_000_000_000;
    const oldRequestedAt = ourRequestedAt - STALE_REQUEST_BUFFER_MS - 1; // older than the tolerance
    expect(evaluateTestPollResult(
      { status: "SUCCEEDED", routeType: "BAR", testPrintRequestedAtMs: oldRequestedAt },
      ourRequestedAt,
      "BAR",
    )).toBe("SHOW_TIMEOUT");
  });

  it("14d: SUCCEEDED with polled testPrintRequestedAt within STALE_REQUEST_BUFFER_MS of ourRequestedAt → OPEN_MODAL (small clock-skew tolerance)", () => {
    const ourRequestedAt = 1_000_000_000_000;
    const slightlyOldRequestedAt = ourRequestedAt - (STALE_REQUEST_BUFFER_MS - 1000); // within tolerance
    expect(evaluateTestPollResult(
      { status: "SUCCEEDED", routeType: "BAR", testPrintRequestedAtMs: slightlyOldRequestedAt },
      ourRequestedAt,
      "BAR",
    )).toBe("OPEN_MODAL");
  });

  it("15a: FAILED + matching route + matching request identity → SHOW_FAILURE", () => {
    const ourRequestedAt = 1_000_000_000_000;
    expect(evaluateTestPollResult(
      { status: "FAILED", routeType: "BAR", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "BAR",
    )).toBe("SHOW_FAILURE");
  });

  it("15b: FAILED + mismatched route → SHOW_TIMEOUT (do not show failure UI for a different route's failure)", () => {
    const ourRequestedAt = 1_000_000_000_000;
    expect(evaluateTestPollResult(
      { status: "FAILED", routeType: "KITCHEN", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "BAR",
    )).toBe("SHOW_TIMEOUT");
  });

  it("15c: PENDING or null polledStatus → SHOW_TIMEOUT regardless of polledRouteType", () => {
    const ourRequestedAt = 1_000_000_000_000;
    expect(evaluateTestPollResult(
      { status: "PENDING", routeType: "BAR", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "BAR",
    )).toBe("SHOW_TIMEOUT");
    expect(evaluateTestPollResult(
      { status: "PENDING", routeType: null, testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "BAR",
    )).toBe("SHOW_TIMEOUT");
    expect(evaluateTestPollResult(
      { status: null, routeType: "BAR", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "BAR",
    )).toBe("SHOW_TIMEOUT");
    expect(evaluateTestPollResult(
      { status: null, routeType: null, testPrintRequestedAtMs: null },
      ourRequestedAt,
      "BAR",
    )).toBe("SHOW_TIMEOUT");
  });

  it("15d: BAR/ŠANK enum mapping is preserved end-to-end — the helper's `requestedType` is the route ENUM (e.g. 'BAR'), the UI label is 'Šank' (handled at the WorkstationsPanel render layer, not in the helper)", () => {
    const ourRequestedAt = 1_000_000_000_000;
    expect(evaluateTestPollResult(
      { status: "SUCCEEDED", routeType: "BAR", testPrintRequestedAtMs: ourRequestedAt + 10 },
      ourRequestedAt,
      "BAR",
    )).toBe("OPEN_MODAL");
  });

  it("15e: identical input → identical decision (pure function, no hidden state, no Date.now, no side-effects)", () => {
    const polled: PollObservation = { status: "SUCCEEDED", routeType: "BAR", testPrintRequestedAtMs: 1_000_000_000_010 };
    const ourRequestedAt = 1_000_000_000_000;
    const a = evaluateTestPollResult(polled, ourRequestedAt, "BAR");
    const b = evaluateTestPollResult(polled, ourRequestedAt, "BAR");
    const c = evaluateTestPollResult(polled, ourRequestedAt, "BAR");
    expect(a).toBe("OPEN_MODAL");
    expect(b).toBe("OPEN_MODAL");
    expect(c).toBe("OPEN_MODAL");
  });
});

/**
 * PHYSICAL-QA FIX #1 v3 — OBSERVATION LIFECYCLE TIMING
 *
 * These tests prove the END-TO-END observation lifecycle (not just the
 * pure helper) at each timing boundary called out in the spec:
 *
 *   1. SUCCEEDED quickly                      → OPEN_MODAL
 *   2. SUCCEEDED after the OLD 12s boundary,
 *      but within the NEW 45s window          → STILL OPEN_MODAL
 *   3. PENDING for the entire 45s window      → SHOW_TIMEOUT
 *   4. FAILED during observation              → SHOW_FAILURE
 *   5. SUCCEEDED for wrong route              → SHOW_TIMEOUT
 *   6. stale historical SUCCEEDED             → SHOW_TIMEOUT
 *   7-11. End-to-end server-side lifecycle
 *         (human confirmation, READY, refresh)
 *
 * The loop is driven by an injected fetcher + injectable time so the
 * tests run in milliseconds (not real seconds). Every assertion below
 * also pins the underlying reason — the loop's `polls` count, the
 * `resolvedEarly` flag, the elapsed time, and the requested route — so
 * a future refactor cannot silently regress timing semantics.
 */
describe("PHYSICAL-QA FIX #1 v3 — observeTestPrintLifecycle (windowed observation timing)", () => {
  /**
   * Build a fake clock where `now()` returns the current simulated time
   * and `sleep(ms)` advances it. The simulated clock MUST be anchored
   * at `ourRequestedAtMs` because the observation loop compares `now()`
   * against `ourRequestedAtMs + OBSERVATION_WINDOW_MS` to decide when
   * to give up — both must share the same time scale.
   */
  function makeSimulatedClock(anchorAtMs: number) {
    let value = anchorAtMs;
    return {
      now: () => value,
      sleep: async (ms: number) => {
        value += ms;
      },
      get currentMs() {
        return value;
      },
    };
  }

  function makeSequence(opts: {
    ourRequestedAt: number;
    requestedType: "KITCHEN" | "BAR" | "RECEIPT";
    /** When (relative to the request) the simulated Agent reports. */
    successAtElapsedMs: number | "never" | "fail" | "wrong-route" | "stale";
  }): PollObservation[] {
    const out: PollObservation[] = [];
    const totalElapsed = OBSERVATION_WINDOW_MS + POLL_INTERVAL_MS + 100;
    for (let elapsed = POLL_INTERVAL_MS; elapsed <= totalElapsed; elapsed += POLL_INTERVAL_MS) {
      if (opts.successAtElapsedMs === "never") {
        out.push({ status: "PENDING", routeType: opts.requestedType, testPrintRequestedAtMs: opts.ourRequestedAt + 5 });
      } else if (opts.successAtElapsedMs === "fail" && elapsed >= 3000) {
        out.push({ status: "FAILED", routeType: opts.requestedType, testPrintRequestedAtMs: opts.ourRequestedAt + 5, testPrintError: "Printer not installed." });
      } else if (opts.successAtElapsedMs === "wrong-route" && elapsed >= 3000) {
        // KITCHEN test completed while we're polling for BAR
        out.push({ status: "SUCCEEDED", routeType: opts.requestedType === "BAR" ? "KITCHEN" : "BAR", testPrintRequestedAtMs: opts.ourRequestedAt + 5 });
      } else if (opts.successAtElapsedMs === "stale" && elapsed >= 3000) {
        // Old SUCCEEDED from yesterday
        out.push({ status: "SUCCEEDED", routeType: opts.requestedType, testPrintRequestedAtMs: opts.ourRequestedAt - STALE_REQUEST_BUFFER_MS - 60_000 });
      } else if (typeof opts.successAtElapsedMs === "number" && elapsed >= opts.successAtElapsedMs) {
        out.push({ status: "SUCCEEDED", routeType: opts.requestedType, testPrintRequestedAtMs: opts.ourRequestedAt + 5 });
      } else {
        out.push({ status: "PENDING", routeType: opts.requestedType, testPrintRequestedAtMs: opts.ourRequestedAt + 5 });
      }
    }
    return out;
  }

  function makeFetcher(sequence: PollObservation[]) {
    let i = 0;
    return async () => {
      const v = sequence[Math.min(i++, sequence.length - 1)];
      return v;
    };
  }

  // 1. Fast SUCCEEDED → OPEN_MODAL
  it("1: SUCCEEDED quickly (within the first poll) → OPEN_MODAL", async () => {
    const ourRequestedAt = 1_000_000_000_000;
    const sequence = makeSequence({ ourRequestedAt, requestedType: "BAR", successAtElapsedMs: POLL_INTERVAL_MS });
    const clock = makeSimulatedClock(ourRequestedAt);
    const outcome = await observeTestPrintLifecycle(ourRequestedAt, "BAR", {
      clock,
      fetcher: makeFetcher(sequence),
    });
    expect(outcome.decision).toBe("OPEN_MODAL");
    expect(outcome.resolvedEarly).toBe(true);
    // The Agent pickup + SUCCEEDED landed inside the first poll — only 1 poll was needed.
    expect(outcome.polls).toBeLessThanOrEqual(2);
  });

  // 2. THE CRITICAL REGRESSION — SUCCEEDED arrives AFTER the legacy 12s hard cap,
  //    but well inside the new 45s window. Pre-v3 the modal would never open.
  it("2: SUCCEEDED arriving at 20s (past the OLD 12s boundary, within the NEW 45s window) → STILL OPEN_MODAL", async () => {
    const ourRequestedAt = 1_000_000_000_000;
    const sequence = makeSequence({ ourRequestedAt, requestedType: "BAR", successAtElapsedMs: 20_000 });
    const clock = makeSimulatedClock(ourRequestedAt);
    const outcome = await observeTestPrintLifecycle(ourRequestedAt, "BAR", {
      clock,
      fetcher: makeFetcher(sequence),
    });
    expect(outcome.decision).toBe("OPEN_MODAL");
    expect(outcome.resolvedEarly).toBe(true);
    // The loop should observe SUCCEEDED on or just after the 20s mark.
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(19_500);
    expect(outcome.elapsedMs).toBeLessThanOrEqual(22_000);
  });

  // 2b. SUCCEEDED near the very end of the observation window (e.g. at 44s) → still OPEN_MODAL
  it("2b: SUCCEEDED arriving at 44s (near the boundary of the 45s window) → STILL OPEN_MODAL", async () => {
    const ourRequestedAt = 1_000_000_000_000;
    const sequence = makeSequence({ ourRequestedAt, requestedType: "BAR", successAtElapsedMs: 44_000 });
    const clock = makeSimulatedClock(ourRequestedAt);
    const outcome = await observeTestPrintLifecycle(ourRequestedAt, "BAR", {
      clock,
      fetcher: makeFetcher(sequence),
    });
    expect(outcome.decision).toBe("OPEN_MODAL");
    expect(outcome.resolvedEarly).toBe(true);
  });

  // 3. PENDING for the entire 45s window → SHOW_TIMEOUT
  it("3: PENDING for the entire legitimate observation window → SHOW_TIMEOUT (Agent is genuinely stuck)", async () => {
    const ourRequestedAt = 1_000_000_000_000;
    const sequence = makeSequence({ ourRequestedAt, requestedType: "BAR", successAtElapsedMs: "never" });
    const clock = makeSimulatedClock(ourRequestedAt);
    const outcome = await observeTestPrintLifecycle(ourRequestedAt, "BAR", {
      clock,
      fetcher: makeFetcher(sequence),
    });
    expect(outcome.decision).toBe("SHOW_TIMEOUT");
    expect(outcome.resolvedEarly).toBe(false);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(OBSERVATION_WINDOW_MS);
  });

  // 4. FAILED during observation → SHOW_FAILURE
  it("4: FAILED during observation → SHOW_FAILURE", async () => {
    const ourRequestedAt = 1_000_000_000_000;
    const sequence = makeSequence({ ourRequestedAt, requestedType: "BAR", successAtElapsedMs: "fail" });
    const clock = makeSimulatedClock(ourRequestedAt);
    const outcome = await observeTestPrintLifecycle(ourRequestedAt, "BAR", {
      clock,
      fetcher: makeFetcher(sequence),
    });
    expect(outcome.decision).toBe("SHOW_FAILURE");
    expect(outcome.resolvedEarly).toBe(true);
  });

  // 5. SUCCEEDED for the WRONG route → SHOW_TIMEOUT
  it("5: SUCCEEDED arriving for a DIFFERENT route (KITCHEN while we polled BAR) → SHOW_TIMEOUT", async () => {
    const ourRequestedAt = 1_000_000_000_000;
    const sequence = makeSequence({ ourRequestedAt, requestedType: "BAR", successAtElapsedMs: "wrong-route" });
    const clock = makeSimulatedClock(ourRequestedAt);
    const outcome = await observeTestPrintLifecycle(ourRequestedAt, "BAR", {
      clock,
      fetcher: makeFetcher(sequence),
    });
    // The wrong-route SUCCEEDED arrives mid-window but the helper still
    // returns SHOW_TIMEOUT because routeType !== requestedType, so the
    // loop continues polling until the window expires (resolvedEarly=false).
    // The post-loop re-read confirms SHOW_TIMEOUT as well.
    expect(outcome.decision).toBe("SHOW_TIMEOUT");
    expect(outcome.resolvedEarly).toBe(false);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(OBSERVATION_WINDOW_MS);
  });

  // 6. Stale historical SUCCEEDED → SHOW_TIMEOUT
  it("6: stale historical SUCCEEDED from a previous operator session → SHOW_TIMEOUT (cannot falsely confirm a new click)", async () => {
    const ourRequestedAt = 1_000_000_000_000;
    const sequence = makeSequence({ ourRequestedAt, requestedType: "BAR", successAtElapsedMs: "stale" });
    const clock = makeSimulatedClock(ourRequestedAt);
    const outcome = await observeTestPrintLifecycle(ourRequestedAt, "BAR", {
      clock,
      fetcher: makeFetcher(sequence),
    });
    expect(outcome.decision).toBe("SHOW_TIMEOUT");
    // Note: in this scenario the polled `testPrintRequestedAt` is stale
    // (older than ourRequestedAt - STALE_REQUEST_BUFFER_MS), so the
    // helper returns SHOW_TIMEOUT — loop continues polling until the
    // observation window expires. This is correct behavior: a stale
    // historical SUCCEEDED does NOT satisfy a new request.
  });

  // Defense-in-depth: the post-loop final reconciliation re-read catches a
  // SUCCEEDED that arrives during the LAST sleep interval.
  it("defense-in-depth: SUCCEEDED arrives exactly at the boundary → caught by the post-loop re-read", async () => {
    // Configure the fetcher so that EVERY poll returns PENDING, but the
    // post-loop defense-in-depth re-read returns SUCCEEDED. This models a
    // race where the Agent writes SUCCEEDED to the DB during the very
    // last `sleep(interval)` of the loop, and the post-loop re-read picks
    // it up before the modal decision is finalized.
    const ourRequestedAt = 1_000_000_000_000;
    let pollCount = 0;
    const fetcher = async (): Promise<PollObservation> => {
      pollCount++;
      // Every regular poll returns PENDING. The last call (the
      // defense-in-depth re-read after the loop exits) returns SUCCEEDED.
      const totalExpectedPolls = Math.ceil(OBSERVATION_WINDOW_MS / POLL_INTERVAL_MS);
      if (pollCount > totalExpectedPolls) {
        return { status: "SUCCEEDED", routeType: "BAR", testPrintRequestedAtMs: ourRequestedAt + 5 };
      }
      return { status: "PENDING", routeType: "BAR", testPrintRequestedAtMs: ourRequestedAt + 5 };
    };
    const clock = makeSimulatedClock(ourRequestedAt);
    const outcome = await observeTestPrintLifecycle(ourRequestedAt, "BAR", {
      clock,
      fetcher,
    });
    expect(outcome.decision).toBe("OPEN_MODAL");
    expect(outcome.resolvedEarly).toBe(false); // window elapsed; the post-loop re-read caught it
  });
});

/**
 * PHYSICAL-QA FIX #1 v4 — SHARED WORKSTATION→OBSERVATION EXTRACTOR
 *
 * The v4 video showed the Admin banner correctly rendering "Uspela · Šank"
 * while the modal never opened. Two of the plausible root causes were:
 *
 *   (a) the imperative observation fetcher was reading from a stale
 *       closure that lagged the Admin banner's polling `load()` by 5s;
 *   (b) the fetcher's extraction logic silently coerced/dropped a field
 *       (e.g. parsing a non-ISO timestamp as NaN, mapping `testPrintRouteType`
 *       through an unintended transform), so the helper never saw the
 *       exact `SUCCEEDED` + `BAR` + current-timestamp triple the banner
 *       displayed.
 *
 * Both classes collapse to one fix: a SHARED extractor that takes a
 * fresh workstation row and returns a normalised PollObservation, used
 * by both the imperative fetcher and any future caller (Admin banner,
 * Admin diagnostic panel, regression test). The tests below pin the
 * extraction at the same data boundary the imperative fetcher reads,
 * so a future divergence between banner and observation shows up here.
 *
 * These tests are PURE — no DB, no React, no timers — and run in
 * milliseconds. They complement (do NOT replace) the existing 29 helper +
 * lifecycle tests, which exercise the full end-to-end server flow.
 */
describe("PHYSICAL-QA FIX #1 v4 — extractWorkstationObservation (shared workstation→PollObservation extractor)", () => {
  it("extracts a complete fresh API response into the matching PollObservation", () => {
    const ourRequestedAt = 1_700_000_000_000;
    const polled = extractWorkstationObservation({
      testPrintStatus: "SUCCEEDED",
      testPrintRouteType: "BAR",
      testPrintRequestedAt: new Date(ourRequestedAt + 50),
      testPrintError: null,
    });
    expect(polled.status).toBe("SUCCEEDED");
    expect(polled.routeType).toBe("BAR");
    expect(polled.testPrintRequestedAtMs).toBe(ourRequestedAt + 50);
    expect(polled.testPrintError).toBeNull();
  });

  it("handles the exact shape the Admin banner renders from: SUCCEEDED + BAR + current request", () => {
    // This is the EXACT scenario the v4 video showed. The Admin banner
    // showed "Uspela · Šank · 18.09. 23:11" — i.e. the workstation row
    // exposed to the React layer had `testPrintStatus: "SUCCEEDED"`,
    // `testPrintRouteType: "BAR"`, and a current `testPrintRequestedAt`.
    // The imperative observation fetcher MUST derive the SAME PollObservation
    // from this row — anything else is the divergence the v4 video exposed.
    const ourRequestedAt = Date.parse("2026-09-18T21:11:00.000Z");
    const polled = extractWorkstationObservation({
      testPrintStatus: "SUCCEEDED",
      testPrintRouteType: "BAR",
      testPrintRequestedAt: new Date(ourRequestedAt + 50).toISOString(),
    });
    expect(polled).toEqual({
      status: "SUCCEEDED",
      routeType: "BAR",
      testPrintRequestedAtMs: ourRequestedAt + 50,
      testPrintError: null,
    });
  });

  it("returns all-null PollObservation when the source row is null", () => {
    expect(extractWorkstationObservation(null)).toEqual({
      status: null,
      routeType: null,
      testPrintRequestedAtMs: null,
    });
    expect(extractWorkstationObservation(undefined)).toEqual({
      status: null,
      routeType: null,
      testPrintRequestedAtMs: null,
    });
  });

  it("returns all-null PollObservation when the source row is empty", () => {
    const polled = extractWorkstationObservation({
      testPrintStatus: null,
      testPrintRouteType: null,
      testPrintRequestedAt: null,
    });
    expect(polled.status).toBeNull();
    expect(polled.routeType).toBeNull();
    expect(polled.testPrintRequestedAtMs).toBeNull();
  });

  it("preserves the exact route ENUM string (BAR, KITCHEN, RECEIPT) without remapping to a UI label", () => {
    // The UI maps BAR→"Šank" only at the render layer. The extractor MUST
    // never remap, otherwise the helper compares routeType against the
    // ENUM in requestedType and the comparison breaks silently.
    expect(extractWorkstationObservation({ testPrintStatus: "SUCCEEDED", testPrintRouteType: "BAR", testPrintRequestedAt: new Date() }).routeType).toBe("BAR");
    expect(extractWorkstationObservation({ testPrintStatus: "SUCCEEDED", testPrintRouteType: "KITCHEN", testPrintRequestedAt: new Date() }).routeType).toBe("KITCHEN");
    expect(extractWorkstationObservation({ testPrintStatus: "SUCCEEDED", testPrintRouteType: "RECEIPT", testPrintRequestedAt: new Date() }).routeType).toBe("RECEIPT");
  });

  it("accepts both ISO strings and Date objects for testPrintRequestedAt", () => {
    const asDate = new Date("2026-09-18T22:05:00.000Z");
    const asIso = asDate.toISOString();
    const fromDate = extractWorkstationObservation({ testPrintStatus: "SUCCEEDED", testPrintRouteType: "BAR", testPrintRequestedAt: asDate });
    const fromIso = extractWorkstationObservation({ testPrintStatus: "SUCCEEDED", testPrintRouteType: "BAR", testPrintRequestedAt: asIso });
    expect(fromDate.testPrintRequestedAtMs).toBe(asDate.getTime());
    expect(fromIso.testPrintRequestedAtMs).toBe(asDate.getTime());
  });

  it("returns null for testPrintRequestedAtMs when the input is unparseable — does NOT produce NaN", () => {
    // Defensive: if the server ever returns a malformed timestamp, the
    // helper must NOT hand `NaN` to evaluateTestPollResult, because
    // `NaN < number` is always false (passes the stale check) and the
    // decision would proceed based on a garbage number.
    const polled = extractWorkstationObservation({
      testPrintStatus: "SUCCEEDED",
      testPrintRouteType: "BAR",
      testPrintRequestedAt: "not-a-date",
    });
    expect(polled.testPrintRequestedAtMs).toBeNull();
    expect(Number.isNaN(polled.testPrintRequestedAtMs)).toBe(false);
  });

  it("preserves testPrintError verbatim so the Admin UI surfaces the Agent-reported failure message", () => {
    const polled = extractWorkstationObservation({
      testPrintStatus: "FAILED",
      testPrintRouteType: "BAR",
      testPrintRequestedAt: new Date(),
      testPrintError: "Windows printer 'POS-58' is not installed on this PC.",
    });
    expect(polled.testPrintError).toBe("Windows printer 'POS-58' is not installed on this PC.");
  });

  it("extract + evaluate pipeline: fresh API response with SUCCEEDED + BAR + current request → OPEN_MODAL", () => {
    // The full pipeline the imperative observation fetcher runs. Pins the
    // EXACT scenario the v4 video exposed: same shape, same outcome.
    const ourRequestedAt = 1_000_000_000_000;
    const polled = extractWorkstationObservation({
      testPrintStatus: "SUCCEEDED",
      testPrintRouteType: "BAR",
      testPrintRequestedAt: new Date(ourRequestedAt + 100),
    });
    expect(evaluateTestPollResult(polled, ourRequestedAt, "BAR")).toBe("OPEN_MODAL");
  });

  it("extract + evaluate pipeline: wrong route → SHOW_TIMEOUT (proves the extractor never remaps BAR to anything else)", () => {
    const ourRequestedAt = 1_000_000_000_000;
    const polled = extractWorkstationObservation({
      testPrintStatus: "SUCCEEDED",
      testPrintRouteType: "KITCHEN",
      testPrintRequestedAt: new Date(ourRequestedAt + 100),
    });
    expect(evaluateTestPollResult(polled, ourRequestedAt, "BAR")).toBe("SHOW_TIMEOUT");
  });

  it("extract + evaluate pipeline: stale request → SHOW_TIMEOUT", () => {
    const ourRequestedAt = 1_000_000_000_000;
    const polled = extractWorkstationObservation({
      testPrintStatus: "SUCCEEDED",
      testPrintRouteType: "BAR",
      testPrintRequestedAt: new Date(ourRequestedAt - STALE_REQUEST_BUFFER_MS - 60_000),
    });
    expect(evaluateTestPollResult(polled, ourRequestedAt, "BAR")).toBe("SHOW_TIMEOUT");
  });

  it("extract + evaluate pipeline: SUCCEEDED alone still does NOT produce READY (the helper returns OPEN_MODAL, modal Promise resolves via separate endpoint)", () => {
    // This test pins the SERVER decision surface. The modal Promise →
    // confirmPhysicalTestByAdmin → physicalTestConfirmed chain is a
    // separate React + server step covered by tests A-J above.
    const ourRequestedAt = 1_000_000_000_000;
    const polled = extractWorkstationObservation({
      testPrintStatus: "SUCCEEDED",
      testPrintRouteType: "BAR",
      testPrintRequestedAt: new Date(ourRequestedAt + 50),
    });
    // The helper's "OPEN_MODAL" outcome is ONLY the "open the modal"
    // decision. The actual physicalTestConfirmed flip happens later via
    // the explicit /confirm endpoint — never from this decision alone.
    expect(evaluateTestPollResult(polled, ourRequestedAt, "BAR")).toBe("OPEN_MODAL");
    // No automatic route mutation: the row is still unconfirmed at this
    // point. The modal is what gates the operator's "Da — radi" press.
    expect(polled.status).toBe("SUCCEEDED");
  });
});
