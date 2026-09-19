import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import type { AuthContext, WorkstationAuthContext } from "@rcs/auth";
import { workstations } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

/**
 * PHYSICAL-QA FIX #1 — REGRESSION FOR PROJECTION BUG (CONFIRMED ROOT CAUSE)
 *
 * Bug: `WORKSTATION_PUBLIC_SELECT.printRoutes.select` in
 *   packages/domain/workstations/workstation-service.ts:78-89
 * omitted `physicalTestConfirmed`, `physicalTestConfirmedAt`,
 * `physicalTestConfirmedBy`. The Admin `GET /api/admin/workstations`
 * readback (WorkstationsPanel's `load()` polls this every 5 s) therefore
 * returned every printRoute WITHOUT those fields, so `routeReadiness()`
 * at WorkstationsPanel.tsx:178 evaluated
 *   `if (!route.physicalTestConfirmed) return "NEEDS_CONFIRMATION"`
 * unconditionally — even after a successful POST /confirm that DID
 * persist `physicalTestConfirmed = true` in the DB.
 *
 * The 41 prior FIX #1 tests all exercised either:
 *   - `confirmPhysicalTestByAdmin` directly (returns PRINT_ROUTE_SELECT,
 *     which always had the fields), or
 *   - the observation/timing helpers in apps/web/lib/*.
 * NONE of them called `listWorkstations` and asserted on the projected
 * printRoute fields. That is exactly the gap this test fills.
 *
 * This is a SINGLE focused regression test for the confirmed bug. It
 * exercises the same DB → service → projection → consumer chain that
 * the Admin UI sees, with NO mocking of `listWorkstations` and NO
 * synthetic fixtures for the projected fields — it lets Prisma do the
 * actual projection and inspects the real returned object.
 */

let ctx: AuthContext;
let restaurantId: string;
let locationId: string;

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
  const tenant = await prisma.tenant.create({ data: { name: "Fix1ListProj", slug: randomUUID() } });
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

async function pairAndConfirmKitchen(): Promise<{ workstationId: string; wsCtx: WorkstationAuthContext }> {
  const pairing = await workstations.createPairing(ctx, { locationId });
  const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
  // Configure the route the operator will confirm against.
  await workstations.upsertPrintRoute(ctx, registered.workstationId, "KITCHEN", {
    printerName: "POS-58",
    paperWidthMm: 58,
  });
  // Seed every gate required for READY EXCEPT the physical-test
  // confirmation (which is what /confirm flips):
  //  - visibility probe
  //  - printerAvailable reporter
  //  - online heartbeat
  const route = await prisma.workstationPrintRoute.findFirstOrThrow({
    where: { workstationId: registered.workstationId, type: "KITCHEN" },
  });
  await prisma.workstationPrintRoute.update({
    where: { id: route.id },
    data: {
      visibleToService: true,
      visibleToServiceAt: new Date(),
      printerAvailable: true,
    },
  });
  await prisma.workstation.update({
    where: { id: registered.workstationId },
    data: { lastSeenAt: new Date() },
  });

  // The single human "Da — radi" press, via the SAME service the Admin
  // route handler calls. This writes physicalTestConfirmed=true into the
  // DB; the bug was that the GET readback did not project that field.
  await workstations.confirmPhysicalTestByAdmin(ctx, registered.workstationId, "KITCHEN");

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

describe("FIX #1 — GET /api/admin/workstations readback MUST carry physicalTestConfirmed*", () => {
  it("after confirmPhysicalTestByAdmin, listWorkstations() returns a printRoutes entry with physicalTestConfirmed=true (the projection bug)", async () => {
    // The exact chain the Admin UI goes through: confirm → DB → listWorkstations
    // → response.workstations[i].printRoutes[j].physicalTestConfirmed.
    // Before the fix this assertion failed (field was undefined); after the
    // 3-line addition to WORKSTATION_PUBLIC_SELECT.printRoutes.select it
    // holds.
    const { workstationId } = await pairAndConfirmKitchen();

    // Sanity: DB carries the truth (proves the confirm path itself is fine).
    const dbRow = await prisma.workstationPrintRoute.findFirstOrThrow({
      where: { workstationId, type: "KITCHEN" },
    });
    expect(dbRow.physicalTestConfirmed).toBe(true);
    expect(dbRow.physicalTestConfirmedAt).toBeInstanceOf(Date);
    expect(dbRow.physicalTestConfirmedBy).toBe(`admin:${ctx.employeeId}`);

    // The actual GET readback — listWorkstations powers the Admin
    // /api/admin/workstations endpoint. No mocking.
    const projected = await workstations.listWorkstations(ctx);
    const wsFromList = projected.find((w) => w.id === workstationId);
    expect(wsFromList).toBeDefined();

    const kitchenRoute = wsFromList!.printRoutes.find((r) => r.type === "KITCHEN");
    expect(kitchenRoute).toBeDefined();

    // ───── THE THREE FIELDS THAT WERE MISSING FROM THE SELECT ─────
    expect(kitchenRoute!.physicalTestConfirmed).toBe(true);
    expect(kitchenRoute!.physicalTestConfirmedAt).toBeInstanceOf(Date);
    expect(kitchenRoute!.physicalTestConfirmedBy).toBe(`admin:${ctx.employeeId}`);
  });
});
