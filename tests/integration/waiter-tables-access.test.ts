import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { tables } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

/**
 * Regression coverage for the P0 "WAITER logs in, sees zero tables" incident.
 * Root cause was NOT a bug in tables.listTables/getTable or in
 * requireLocationAccess/scopeToRestaurant — it was that Floor/RestaurantTable
 * rows never existed for the affected restaurant (a dev-environment repair
 * gap, see scripts/dev-repair-accounts.ts). These tests exist because no
 * integration test previously covered listTables/getTable at all — this
 * exact class of bug (or a real scoping regression) would have gone
 * undetected.
 */

interface Fixture {
  restaurantId: string;
  locationAId: string;
  locationBId: string;
  floorAId: string;
  tableAId: string;
  tableBId: string;
}

function context(fixture: Fixture, locationIds: string[], role = "WAITER"): AuthContext {
  return {
    userId: "waiter-1",
    employeeId: "waiter-1",
    restaurantId: fixture.restaurantId,
    locationIds,
    roles: [role],
    permissions: new Set(["menu.view", "shifts.manage"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Waiter tables tenant", slug: `waiter-tables-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const locationA = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Location A" } });
  const locationB = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Location B" } });

  const floorA = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: locationA.id, name: "Glavna sala" } });
  const floorB = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: locationB.id, name: "Bašta" } });

  const tableA = await prisma.restaurantTable.create({ data: { floorId: floorA.id, label: "Sto 1", capacity: 4 } });
  await prisma.restaurantTable.create({ data: { floorId: floorB.id, label: "Sto 1", capacity: 4 } });
  const tableB = await prisma.restaurantTable.findFirstOrThrow({ where: { floorId: floorB.id } });

  return {
    restaurantId: restaurant.id,
    locationAId: locationA.id,
    locationBId: locationB.id,
    floorAId: floorA.id,
    tableAId: tableA.id,
    tableBId: tableB.id,
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("waiter table visibility — location and restaurant scoping", () => {
  it("WAITER assigned to Location A sees Location A's tables", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, [fixture.locationAId]);

    const floors = await tables.listTables(waiter, fixture.locationAId);

    expect(floors).toHaveLength(1);
    expect(floors[0].tables).toHaveLength(1);
    expect(floors[0].tables[0].id).toBe(fixture.tableAId);
  });

  it("WAITER assigned to Location A cannot list Location B's tables (DENIED)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, [fixture.locationAId]);

    await expect(tables.listTables(waiter, fixture.locationBId)).rejects.toThrow();
  });

  it("WAITER assigned to Location A cannot open a table belonging to Location B (DENIED)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, [fixture.locationAId]);

    await expect(tables.getTable(waiter, fixture.tableBId)).rejects.toThrow();
  });

  it("WAITER assigned to Location A can open a table belonging to Location A (ALLOWED)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, [fixture.locationAId]);

    const table = await tables.getTable(waiter, fixture.tableAId);
    expect(table.id).toBe(fixture.tableAId);
  });

  it("a restaurant scoped to a DIFFERENT restaurantId never sees this restaurant's tables, even with a matching locationId", async () => {
    const fixture = await createFixture();
    const otherTenant = await prisma.tenant.create({ data: { name: "Other tenant", slug: `other-${randomUUID()}` } });
    const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: otherTenant.id, name: "Other Restaurant", currency: "RSD" } });

    // Attacker-shaped ctx: correct locationId (guessed/leaked) but wrong restaurantId.
    const foreignCtx: AuthContext = {
      userId: "intruder",
      employeeId: "intruder",
      restaurantId: otherRestaurant.id,
      locationIds: [fixture.locationAId],
      roles: ["WAITER"],
      permissions: new Set(["menu.view"]),
    };

    const floors = await tables.listTables(foreignCtx, fixture.locationAId);
    expect(floors).toHaveLength(0); // scopeToRestaurant(ctx) excludes the other restaurant's floor entirely
  });

  it("a location with zero floors/tables returns an empty array, not an error (the exact P0 symptom, now provably just 'no data' — not a crash or scoping bug)", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Empty tenant", slug: `empty-${randomUUID()}` } });
    const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Empty Restaurant", currency: "RSD" } });
    const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Empty Location" } });
    const waiter: AuthContext = {
      userId: "w",
      employeeId: "w",
      restaurantId: restaurant.id,
      locationIds: [location.id],
      roles: ["WAITER"],
      permissions: new Set(["menu.view"]),
    };

    const floors = await tables.listTables(waiter, location.id);
    expect(floors).toEqual([]);
  });

  it("OWNER/ADMIN/MANAGER with the same location access see the same tables as WAITER (role does not change table visibility)", async () => {
    const fixture = await createFixture();
    for (const role of ["OWNER", "ADMIN", "MANAGER"]) {
      const ctx = context(fixture, [fixture.locationAId], role);
      const floors = await tables.listTables(ctx, fixture.locationAId);
      expect(floors[0]?.tables).toHaveLength(1);
    }
  });
});
