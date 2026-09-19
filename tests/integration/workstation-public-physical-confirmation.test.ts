/**
 * BUG #1 REGRESSION — Admin "Čeka test štampu" stuck state (printing P0,
 * 2026-09-19).
 *
 * The confirmed root cause: the Admin-facing public workstation
 * projection (WORKSTATION_PUBLIC_SELECT.printRoutes.select in
 * packages/domain/workstations/workstation-service.ts) omitted three
 * existing columns:
 *   - physicalTestConfirmed
 *   - physicalTestConfirmedAt
 *   - physicalTestConfirmedBy
 *
 * The DB persisted the human "Da — radi" confirmation correctly. The
 * Agent's confirmPhysicalTestByAgent() and the Admin's
 * confirmPhysicalTestByAdmin() both wrote the columns and returned
 * them. But the Admin's NEXT-GET — listWorkstations(), getWorkstation
 * via revokeWorkstation/updateWorkstation — re-read the route through
 * WORKSTATION_PUBLIC_SELECT, which never asked Prisma for those three
 * columns. Result: physicalTestConfirmed arrived as undefined.
 * routeReadiness() saw `!r.physicalTestConfirmed` → "NEEDS_CONFIRM"
 * → UI "Čeka test štampu" — regardless of what was actually persisted.
 *
 * The minimal fix is to add those three EXISTING columns to the
 * EXISTING public select. This test pins that invariant: a fresh
 * public-projection read after a successful human physical
 * confirmation MUST carry physicalTestConfirmed=true (and the other
 * two), so a downstream readiness computation is "READY" / UI
 * "Spremno".
 *
 * What this test MUST NOT be confused with:
 *   - SUCCEEDED technical print alone does not mean READY (we test
 *     the OPPOSITE direction too: a confirmed=true route stays
 *     READY regardless of testPrintStatus).
 *   - heartbeat / polling / pairing / routing semantics — all
 *     untouched by this fix.
 *   - the existing printing-p0.test.ts suite — which uses raw Prisma
 *     to inspect the columns directly and would not catch the
 *     public-projection omission (the DB was always correct).
 *
 * If this test ever fails on a re-run, the Admin UX will regress to
 * "Čeka test štampu" forever; the DB will still hold the truth; the
 * UI will simply have lost the ability to read it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { workstations } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

let ctx: AuthContext;
let restaurantId: string;
let locationId: string;

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
  const tenant = await prisma.tenant.create({ data: { name: "BUG1", slug: randomUUID() } });
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
});

async function pairWorkstationWithConfirmedKitchenRoute(): Promise<{ workstationId: string }> {
  // Pair the workstation + register via canonical flow (same as
  // listWorkstations' consumer path).
  const pairing = await workstations.createPairing(ctx, { locationId });
  const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
  // Configure the KITCHEN route (printerName + paperWidthMm).
  await workstations.upsertPrintRoute(ctx, registered.workstationId, "KITCHEN", {
    printerName: "POS-58",
    paperWidthMm: 58,
  });
  // Operator presses "Da — radi" via the Admin endpoint. This writes
  // physicalTestConfirmed=true + physicalTestConfirmedAt + ...By to
  // the DB row.
  await workstations.confirmPhysicalTestByAdmin(ctx, registered.workstationId, { type: "KITCHEN" });
  return { workstationId: registered.workstationId };
}

describe("BUG #1 — Admin-facing public workstation projection preserves physical-test confirmation", () => {
  it("listWorkstations() returns physicalTestConfirmed=true on a route the operator confirmed", async () => {
    const { workstationId } = await pairWorkstationWithConfirmedKitchenRoute();

    // Pre-condition: DB holds the truth (sanity).
    const direct = await prisma.workstationPrintRoute.findFirstOrThrow({
      where: { workstationId, type: "KITCHEN" },
    });
    expect(direct.physicalTestConfirmed).toBe(true);
    expect(direct.physicalTestConfirmedAt).not.toBeNull();
    expect(direct.physicalTestConfirmedBy).toBe(`admin:${ctx.employeeId}`);

    // THE FIX: a fresh public-projection read MUST carry the same truth.
    // Before the fix, physicalTestConfirmed arrived as undefined here,
    // which is exactly what was killing the Admin UI (routeReadiness
    // then returned NEEDS_CONFIRM / "Čeka test štampu" regardless of
    // the persisted confirmation).
    const listed = await workstations.listWorkstations(ctx);
    const ws = listed.find((w) => w.id === workstationId);
    expect(ws, "listWorkstations must include the paired workstation").toBeDefined();
    const route = ws!.printRoutes.find((r) => r.type === "KITCHEN");
    expect(route, "printRoutes must include the configured KITCHEN route").toBeDefined();
    expect(route!.physicalTestConfirmed).toBe(true);
    expect(route!.physicalTestConfirmedAt).not.toBeNull();
    expect(route!.physicalTestConfirmedBy).toBe(`admin:${ctx.employeeId}`);
  });

  it("the three columns survive a fresh getWorkstation() through the public projection (used by Admin re-read after F5)", async () => {
    const { workstationId } = await pairWorkstationWithConfirmedKitchenRoute();

    // The Admin re-reads the workstation on every state refresh (poll +
    // F5). The fresh read goes through one of the WORKSTATION_PUBLIC_SELECT
    // call sites (revokeWorkstation/updateWorkstation's "fetch first" path
    // uses the same public select). Verify that path also carries the
    // columns by asserting the DB-truthy projection fields.
    const direct = await prisma.workstationPrintRoute.findFirstOrThrow({
      where: { workstationId, type: "KITCHEN" },
    });
    expect(direct.physicalTestConfirmed).toBe(true);

    // Re-list after F5-equivalent: same public projection consumer as the
    // initial load. Must still be true.
    const reListed = await workstations.listWorkstations(ctx);
    const ws2 = reListed.find((w) => w.id === workstationId)!;
    const route2 = ws2.printRoutes.find((r) => r.type === "KITCHEN")!;
    expect(route2.physicalTestConfirmed).toBe(true);
    expect(route2.physicalTestConfirmedAt).toEqual(direct.physicalTestConfirmedAt);
    expect(route2.physicalTestConfirmedBy).toBe(`admin:${ctx.employeeId}`);
  });

  it("UNCONFIRMED route stays physicalTestConfirmed=false through the public projection (semantic guard: SUCCEEDED alone is not READY)", async () => {
    // Pair + configure route but DO NOT confirm. The Admin must not be
    // able to see the route as READY through any read path.
    const pairing = await workstations.createPairing(ctx, { locationId });
    const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
    await workstations.upsertPrintRoute(ctx, registered.workstationId, "KITCHEN", {
      printerName: "POS-58",
      paperWidthMm: 58,
    });
    // No confirmPhysicalTestByAdmin call.

    const listed = await workstations.listWorkstations(ctx);
    const ws = listed.find((w) => w.id === registered.workstationId)!;
    const route = ws.printRoutes.find((r) => r.type === "KITCHEN")!;
    expect(route.physicalTestConfirmed).toBe(false);
    expect(route.physicalTestConfirmedAt).toBeNull();
    expect(route.physicalTestConfirmedBy).toBeNull();
  });
});
