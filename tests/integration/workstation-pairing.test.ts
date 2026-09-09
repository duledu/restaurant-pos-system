import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { workstations } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

let ctx: AuthContext;
let restaurantId: string;
let locationId: string;
let otherRestaurantId: string;
let otherLocationId: string;

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
  const tenant = await prisma.tenant.create({ data: { name: "Workstations", slug: randomUUID() } });
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

describe("workstation pairing — valid lifecycle", () => {
  it("creates a pairing, consumes it once, and creates a workstation with the returned credential", async () => {
    const pairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN", name: "Kuhinjski računar" });
    expect(pairing.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(pairing.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const registered = await workstations.registerAgentFromPairing({ code: pairing.code, agentVersion: "1.0.0", osDescription: "Windows 10 Pro" });
    expect(registered.restaurantId).toBe(restaurantId);
    expect(registered.locationId).toBe(locationId);
    expect(registered.station).toBe("KITCHEN");
    expect(registered.name).toBe("Kuhinjski računar");
    expect(registered.credential).toMatch(/^tcpa1_/);
    expect(registered.credential.length).toBeGreaterThan(40);

    const row = await prisma.workstation.findUniqueOrThrow({ where: { id: registered.workstationId } });
    expect(row.credentialHash).not.toBe(registered.credential);
    expect(row.pairedAt).toBeInstanceOf(Date);
    expect(row.revokedAt).toBeNull();
    expect(row.isEnabled).toBe(true);

    const consumedPairing = await prisma.workstationPairing.findUniqueOrThrow({ where: { id: pairing.pairingId } });
    expect(consumedPairing.status).toBe("CONSUMED");
    expect(consumedPairing.workstationId).toBe(registered.workstationId);
  });

  it("defaults workstation name when none given at pairing creation", async () => {
    const pairing = await workstations.createPairing(ctx, { locationId, station: "BAR" });
    const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
    expect(registered.name).toContain("BAR");
  });
});

describe("workstation pairing — expired / cancelled / reused / concurrent", () => {
  it("rejects an expired pairing code", async () => {
    const pairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    await prisma.workstationPairing.update({ where: { id: pairing.pairingId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(workstations.registerAgentFromPairing({ code: pairing.code })).rejects.toThrow();
    expect(await prisma.workstation.count()).toBe(0);
  });

  it("rejects a cancelled pairing code", async () => {
    const pairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    await workstations.cancelPairing(ctx, pairing.pairingId);
    await expect(workstations.registerAgentFromPairing({ code: pairing.code })).rejects.toThrow();
    expect(await prisma.workstation.count()).toBe(0);
  });

  it("rejects a reused pairing code after a successful consumption", async () => {
    const pairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    await workstations.registerAgentFromPairing({ code: pairing.code });
    await expect(workstations.registerAgentFromPairing({ code: pairing.code })).rejects.toThrow();
    expect(await prisma.workstation.count()).toBe(1);
  });

  it("allows only ONE of two simultaneous consume attempts with the same code to succeed", async () => {
    const pairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    const results = await Promise.allSettled([
      workstations.registerAgentFromPairing({ code: pairing.code }),
      workstations.registerAgentFromPairing({ code: pairing.code }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await prisma.workstation.count()).toBe(1);
  });

  it("cancel is race-safe: cannot cancel a pairing that was just consumed", async () => {
    const pairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    await workstations.registerAgentFromPairing({ code: pairing.code });
    const result = await workstations.cancelPairing(ctx, pairing.pairingId);
    expect(result.status).toBe("CONSUMED"); // never overwritten to CANCELLED
  });
});

describe("workstation pairing — tenant/location/station guards", () => {
  it("rejects creating a pairing for a location outside the admin's tenant/access", async () => {
    await expect(workstations.createPairing(ctx, { locationId: otherLocationId, station: "KITCHEN" })).rejects.toThrow();
  });

  it("rejects creating a pairing for a location the admin has access to but does not belong to their restaurant (forged locationId)", async () => {
    const forgedCtx: AuthContext = { ...ctx, locationIds: [locationId, otherLocationId] };
    await expect(workstations.createPairing(forgedCtx, { locationId: otherLocationId, station: "KITCHEN" })).rejects.toThrow();
  });

  it("rejects an invalid station value at the schema layer", async () => {
    await expect(
      workstations.createPairing(ctx, { locationId, station: "RECEIPT" as never })
    ).rejects.toThrow();
  });

  it("cannot cancel or list a pairing belonging to another restaurant", async () => {
    const otherCtx: AuthContext = { userId: "m2", employeeId: "m2", restaurantId: otherRestaurantId, locationIds: [otherLocationId], roles: ["MANAGER"], permissions: new Set(["workstations.manage"]) };
    const pairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    await expect(workstations.cancelPairing(otherCtx, pairing.pairingId)).rejects.toThrow();
    const otherList = await workstations.listPendingPairings(otherCtx);
    expect(otherList.find((p) => p.id === pairing.pairingId)).toBeUndefined();
  });
});

describe("workstation pairing — no persistent secret stored in plaintext", () => {
  it("the pairing code is never stored verbatim; only its hash is persisted", async () => {
    const pairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    const row = await prisma.workstationPairing.findUniqueOrThrow({ where: { id: pairing.pairingId } });
    expect(row.codeHash).not.toBe(pairing.code);
    expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex

    // Sanity: nothing in the raw DB row (as JSON) contains the raw code substring.
    expect(JSON.stringify(row)).not.toContain(pairing.code);
  });

  it("the persistent workstation credential is never stored verbatim; only its hash is persisted", async () => {
    const pairing = await workstations.createPairing(ctx, { locationId, station: "KITCHEN" });
    const registered = await workstations.registerAgentFromPairing({ code: pairing.code });
    const row = await prisma.workstation.findUniqueOrThrow({ where: { id: registered.workstationId } });
    expect(row.credentialHash).not.toBe(registered.credential);
    expect(row.credentialHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(registered.credential);
  });
});
