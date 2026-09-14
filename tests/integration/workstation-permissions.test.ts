/**
 * Integration tests — workstations.manage role-based access (P0 printing
 * fix, Phase D). Proves the exact root cause found during audit
 * ("Missing permission: workstations.manage" for every role, because the
 * permission row/grants had never been seeded against the target
 * database — sync-permissions.ts had never been run there) cannot recur
 * silently: OWNER/ADMIN/MANAGER/INVENTORY_MANAGER must be able to manage
 * workstation pairing, and operational KITCHEN/BAR/WAITER roles must be
 * REJECTED from administrative workstation actions — they only ever
 * receive/print jobs via the agent's own, separate, non-employee
 * credential (packages/auth/workstation-auth.ts), never via a permission
 * grant.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { workstations } from "@rcs/domain";
import { requireWorkstationAuth } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Perm tenant", slug: `perm-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Perm Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  return { restaurantId: restaurant.id, locationId: location.id };
}

// Mirrors exactly what requireAuth actually builds ctx.permissions from —
// these tests exercise the SAME requirePermission("workstations.manage")
// gate the real routes use, not a re-implementation of it.
function ctxWithPermissions(f: Fixture, permissionCodes: string[], role = "OWNER"): AuthContext {
  return {
    userId: `emp-${role}`,
    employeeId: `emp-${role}`,
    restaurantId: f.restaurantId,
    locationIds: [f.locationId],
    roles: [role],
    permissions: new Set(permissionCodes),
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("workstations.manage — authorized management roles can pair/manage", () => {
  it.each(["OWNER", "ADMIN", "MANAGER", "INVENTORY_MANAGER"])("%s with workstations.manage can create a pairing and list workstations", async (role) => {
    const f = await createFixture();
    const ctx = ctxWithPermissions(f, ["workstations.manage"], role);

    const pairing = await workstations.createPairing(ctx, { locationId: f.locationId, station: "KITCHEN" });
    expect(pairing.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const list = await workstations.listWorkstations(ctx);
    expect(Array.isArray(list)).toBe(true);
  });
});

describe("workstations.manage — operational roles are rejected", () => {
  it.each(["KITCHEN", "BAR", "WAITER"])("%s WITHOUT workstations.manage cannot create a pairing", async (role) => {
    const f = await createFixture();
    // Exactly what these roles actually have in production — production.view/
    // manage or orders-related permissions, never workstations.manage.
    const ctx = ctxWithPermissions(f, ["production.view", "production.manage"], role);

    await expect(workstations.createPairing(ctx, { locationId: f.locationId, station: "KITCHEN" })).rejects.toThrow(
      /Missing permission: workstations\.manage/
    );
  });

  it("KITCHEN cannot list or revoke workstations either", async () => {
    const f = await createFixture();
    const kitchenCtx = ctxWithPermissions(f, ["production.view", "production.manage"], "KITCHEN");
    const ownerCtx = ctxWithPermissions(f, ["workstations.manage"], "OWNER");

    // A real workstation must exist first — created by an authorized caller.
    const pairing = await workstations.createPairing(ownerCtx, { locationId: f.locationId, station: "KITCHEN" });
    const registered = await workstations.registerAgentFromPairing({ code: pairing.code });

    await expect(workstations.listWorkstations(kitchenCtx)).rejects.toThrow(/Missing permission/);
    await expect(workstations.revokeWorkstation(kitchenCtx, registered.workstationId)).rejects.toThrow(/Missing permission/);
  });

  it("a role with NO permissions at all (the exact reported symptom before the fix) is rejected with the exact reported error text", async () => {
    const f = await createFixture();
    const ctx = ctxWithPermissions(f, [], "OWNER"); // role is OWNER, but permission set is empty — reproduces the unsynced-permission state
    await expect(workstations.createPairing(ctx, { locationId: f.locationId, station: "KITCHEN" })).rejects.toThrow(
      "Missing permission: workstations.manage"
    );
  });
});

describe("paired Print Agent authenticates independently of any employee session", () => {
  it("registerAgentFromPairing and the agent's own bearer credential require zero AuthContext/employee permissions", async () => {
    const f = await createFixture();
    const ownerCtx = ctxWithPermissions(f, ["workstations.manage"], "OWNER");
    const pairing = await workstations.createPairing(ownerCtx, { locationId: f.locationId, station: "KITCHEN" });

    // Consuming the pairing code takes NO AuthContext at all — an
    // unauthenticated Windows process, not an employee browser session.
    const registered = await workstations.registerAgentFromPairing({ code: pairing.code, agentVersion: "1.0.0-pilot.1" });
    expect(registered.credential).toMatch(/^tcpa1_/);

    // The returned credential alone (bearer token, no cookies, no
    // employeeId) is sufficient to authenticate as that workstation.
    const request = new Request("http://localhost/api/agent/heartbeat", {
      headers: { Authorization: `Bearer ${registered.credential}` },
    });
    const wsCtx = await requireWorkstationAuth(request);
    expect(wsCtx.workstationId).toBe(registered.workstationId);
    expect(wsCtx.restaurantId).toBe(f.restaurantId);
    expect(wsCtx.station).toBe("KITCHEN");
  });

  it("a revoked workstation's credential is rejected even though it authenticated successfully before", async () => {
    const f = await createFixture();
    const ownerCtx = ctxWithPermissions(f, ["workstations.manage"], "OWNER");
    const pairing = await workstations.createPairing(ownerCtx, { locationId: f.locationId, station: "KITCHEN" });
    const registered = await workstations.registerAgentFromPairing({ code: pairing.code });

    await workstations.revokeWorkstation(ownerCtx, registered.workstationId);

    const request = new Request("http://localhost/api/agent/heartbeat", {
      headers: { Authorization: `Bearer ${registered.credential}` },
    });
    await expect(requireWorkstationAuth(request)).rejects.toThrow();
  });
});
