import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { requireWorkstationAuth, WorkstationUnauthorizedError } from "@rcs/auth";
import { workstations } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

let ctx: AuthContext;
let restaurantId: string;
let locationId: string;
let otherRestaurantId: string;
let otherLocationId: string;

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
  const tenant = await prisma.tenant.create({ data: { name: "Workstation auth", slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "A", currency: "RSD" } });
  const other = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "B" } });
  restaurantId = restaurant.id;
  otherRestaurantId = other.id;
  locationId = (await prisma.location.create({ data: { restaurantId: restaurant.id, name: "A" } })).id;
  otherLocationId = (await prisma.location.create({ data: { restaurantId: other.id, name: "B" } })).id;
  ctx = {
    userId: "manager",
    employeeId: "manager",
    restaurantId,
    locationIds: [locationId],
    roles: ["MANAGER"],
    permissions: new Set(["workstations.manage"]),
  };
});

function bearerRequest(token: string | null): Request {
  return new Request("http://localhost/api/agent/heartbeat", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function pairedWorkstation(station: "KITCHEN" | "BAR" = "KITCHEN") {
  const pairing = await workstations.createPairing(ctx, { locationId, station });
  return workstations.registerAgentFromPairing({ code: pairing.code });
}

describe("workstation device auth — credential resolution", () => {
  it("resolves the correct restaurant/location/station from a valid credential", async () => {
    const registered = await pairedWorkstation("BAR");
    const wsCtx = await requireWorkstationAuth(bearerRequest(registered.credential));
    expect(wsCtx.workstationId).toBe(registered.workstationId);
    expect(wsCtx.restaurantId).toBe(restaurantId);
    expect(wsCtx.locationId).toBe(locationId);
    expect(wsCtx.station).toBe("BAR");
  });

  it("rejects a missing Authorization header", async () => {
    await expect(requireWorkstationAuth(bearerRequest(null))).rejects.toBeInstanceOf(WorkstationUnauthorizedError);
  });

  it("rejects an invalid/unknown credential", async () => {
    await expect(requireWorkstationAuth(bearerRequest("tcpa1_" + randomUUID()))).rejects.toBeInstanceOf(WorkstationUnauthorizedError);
  });

  it("rejects a revoked credential", async () => {
    const registered = await pairedWorkstation();
    await workstations.revokeWorkstation(ctx, registered.workstationId);
    await expect(requireWorkstationAuth(bearerRequest(registered.credential))).rejects.toBeInstanceOf(WorkstationUnauthorizedError);
  });

  it("rejects a disabled (isEnabled=false, not yet revoked) workstation", async () => {
    const registered = await pairedWorkstation();
    // No dedicated "disable" API yet (Phase 2A ships only revoke) — directly
    // toggle isEnabled to prove the auth check honors it independently of
    // revokedAt, exactly as the schema/domain design intends.
    await prisma.workstation.update({ where: { id: registered.workstationId }, data: { isEnabled: false } });
    const row = await prisma.workstation.findUniqueOrThrow({ where: { id: registered.workstationId } });
    expect(row.revokedAt).toBeNull(); // proves this is the "disabled", not "revoked", path
    await expect(requireWorkstationAuth(bearerRequest(registered.credential))).rejects.toBeInstanceOf(WorkstationUnauthorizedError);
  });

  it("a workstation from restaurant A can never resolve as restaurant B, regardless of forged request content", async () => {
    const registered = await pairedWorkstation();
    // requireWorkstationAuth takes ONLY the Request (headers) — there is no
    // code path that reads restaurantId/locationId from a body, so a
    // "forged" request just proves those fields are structurally
    // unreachable, not merely unused.
    const request = new Request("http://localhost/api/agent/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${registered.credential}` },
      body: JSON.stringify({ restaurantId: otherRestaurantId, locationId: otherLocationId }),
    });
    const wsCtx = await requireWorkstationAuth(request);
    expect(wsCtx.restaurantId).toBe(restaurantId);
    expect(wsCtx.restaurantId).not.toBe(otherRestaurantId);
  });
});

describe("workstation heartbeat", () => {
  it("updates lastSeenAt/lastSuccessfulCommunicationAt on a bare heartbeat", async () => {
    const registered = await pairedWorkstation();
    const before = await prisma.workstation.findUniqueOrThrow({ where: { id: registered.workstationId } });
    expect(before.lastSeenAt).toBeNull();

    const wsCtx = await requireWorkstationAuth(bearerRequest(registered.credential));
    await workstations.recordHeartbeat(wsCtx, {});

    const after = await prisma.workstation.findUniqueOrThrow({ where: { id: registered.workstationId } });
    expect(after.lastSeenAt).not.toBeNull();
    expect(after.lastSuccessfulCommunicationAt).not.toBeNull();
  });

  it("throttles rapid successive bare heartbeats (does not rewrite lastSeenAt on every call)", async () => {
    const registered = await pairedWorkstation();
    const wsCtx = await requireWorkstationAuth(bearerRequest(registered.credential));
    await workstations.recordHeartbeat(wsCtx, {});
    const first = await prisma.workstation.findUniqueOrThrow({ where: { id: registered.workstationId } });

    await workstations.recordHeartbeat(wsCtx, {}); // immediately again, well inside the throttle window
    const second = await prisma.workstation.findUniqueOrThrow({ where: { id: registered.workstationId } });

    expect(second.lastSeenAt?.getTime()).toBe(first.lastSeenAt?.getTime());
  });

  it("always applies capability/metadata updates immediately, even inside the throttle window", async () => {
    const registered = await pairedWorkstation();
    const wsCtx = await requireWorkstationAuth(bearerRequest(registered.credential));
    await workstations.recordHeartbeat(wsCtx, {});
    await workstations.recordHeartbeat(wsCtx, { agentVersion: "1.2.3", configuredPrinterName: "POS-58 (1)", paperWidthMm: 58 });

    const row = await prisma.workstation.findUniqueOrThrow({ where: { id: registered.workstationId } });
    expect(row.agentVersion).toBe("1.2.3");
    expect(row.configuredPrinterName).toBe("POS-58 (1)");
    expect(row.paperWidthMm).toBe(58);
  });

  it("rejects an invalid paperWidthMm value (only 58 or 80 are accepted)", async () => {
    const registered = await pairedWorkstation();
    const wsCtx = await requireWorkstationAuth(bearerRequest(registered.credential));
    await expect(workstations.recordHeartbeat(wsCtx, { paperWidthMm: 76 as never })).rejects.toThrow();
  });

  it("a revoked workstation's credential is rejected before any heartbeat can be recorded", async () => {
    const registered = await pairedWorkstation();
    await workstations.revokeWorkstation(ctx, registered.workstationId);
    await expect(requireWorkstationAuth(bearerRequest(registered.credential))).rejects.toBeInstanceOf(WorkstationUnauthorizedError);
  });
});

describe("workstation admin management — permissions and tenant isolation", () => {
  it("never exposes credentialHash/codeHash to admin-facing list/revoke/cancel results, even though they identify the row", async () => {
    const pairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    const registered = await workstations.registerAgentFromPairing({ code: pairing.code });

    const workstationList = await workstations.listWorkstations(ctx);
    const revoked = await workstations.revokeWorkstation(ctx, registered.workstationId);
    const pairingList = await workstations.listPendingPairings(ctx); // empty now (consumed), but proves the shape even so
    for (const payload of [workstationList, revoked, pairingList]) {
      expect(JSON.stringify(payload)).not.toContain("credentialHash");
      expect(JSON.stringify(payload)).not.toContain("codeHash");
    }
  });

  it("an authorized admin can create a pairing, list workstations, and revoke one", async () => {
    const registered = await pairedWorkstation();
    const list = await workstations.listWorkstations(ctx);
    expect(list.map((w) => w.id)).toContain(registered.workstationId);

    const revoked = await workstations.revokeWorkstation(ctx, registered.workstationId);
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.isEnabled).toBe(false);
  });

  it("denies workstation management to a caller without workstations.manage", async () => {
    const denied: AuthContext = { ...ctx, permissions: new Set<string>() };
    await expect(workstations.createPairing(denied, { locationId, station: "KITCHEN" })).rejects.toThrow();
    await expect(workstations.listWorkstations(denied)).rejects.toThrow();
    const registered = await pairedWorkstation();
    await expect(workstations.revokeWorkstation(denied, registered.workstationId)).rejects.toThrow();
  });

  it("a workstation belonging to another restaurant is invisible and inaccessible to this admin", async () => {
    const otherCtx: AuthContext = { userId: "m2", employeeId: "m2", restaurantId: otherRestaurantId, locationIds: [otherLocationId], roles: ["MANAGER"], permissions: new Set(["workstations.manage"]) };
    const otherPairing = await workstations.createPairing(otherCtx, { locationId: otherLocationId, station: "KITCHEN" });
    const otherRegistered = await workstations.registerAgentFromPairing({ code: otherPairing.code });

    const myList = await workstations.listWorkstations(ctx);
    expect(myList.find((w) => w.id === otherRegistered.workstationId)).toBeUndefined();

    await expect(workstations.revokeWorkstation(ctx, otherRegistered.workstationId)).rejects.toThrow();
    // Prove it was NOT revoked by the failed cross-tenant attempt.
    const stillActive = await prisma.workstation.findUniqueOrThrow({ where: { id: otherRegistered.workstationId } });
    expect(stillActive.revokedAt).toBeNull();
  });

  it("revoking one workstation never affects another restaurant's workstation credential", async () => {
    const mine = await pairedWorkstation();
    const otherCtx: AuthContext = { userId: "m2", employeeId: "m2", restaurantId: otherRestaurantId, locationIds: [otherLocationId], roles: ["MANAGER"], permissions: new Set(["workstations.manage"]) };
    const otherPairing = await workstations.createPairing(otherCtx, { locationId: otherLocationId, station: "KITCHEN" });
    const other = await workstations.registerAgentFromPairing({ code: otherPairing.code });

    await workstations.revokeWorkstation(ctx, mine.workstationId);

    const otherWsCtx = await requireWorkstationAuth(bearerRequest(other.credential));
    expect(otherWsCtx.workstationId).toBe(other.workstationId); // other restaurant's credential still works
    await expect(requireWorkstationAuth(bearerRequest(mine.credential))).rejects.toBeInstanceOf(WorkstationUnauthorizedError);
  });
});
