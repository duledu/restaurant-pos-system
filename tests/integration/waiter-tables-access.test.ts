import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { tables, orders } from "@rcs/domain";
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

/**
 * Regression coverage for the "Waiter B taps Waiter A's table and lands on
 * an almost-empty rejected-access screen" UX bug. The fix exposes
 * activeOrderOwnerId (raw employeeId only, never a name) on listTables so
 * the frontend can block navigation BEFORE it happens
 * (lib/table-ownership.ts's isTableHeldByAnotherWaiter). These tests prove:
 * (1) the new field is populated correctly, and (2) the pre-existing
 * server-side authorization (requireDraftOwnership / getOrder) is completely
 * unchanged — a waiter can never gain access to another waiter's order by
 * hitting the API directly, regardless of what the UI does.
 */
describe("waiter table visibility — active order ownership exposure (pre-navigation UX fix)", () => {
  it("a free table (no active order) has activeOrderOwnerId: null", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, [fixture.locationAId]);

    const floors = await tables.listTables(waiter, fixture.locationAId);
    expect(floors[0].tables[0].activeOrderOwnerId).toBeNull();
  });

  it("a table with an active DRAFT order exposes the owning waiter's employeeId", async () => {
    const fixture = await createFixture();
    const shift = await prisma.shift.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationAId, openedBy: "waiter-owner" },
    });
    await prisma.order.create({
      data: {
        restaurantId: fixture.restaurantId,
        locationId: fixture.locationAId,
        tableId: fixture.tableAId,
        shiftId: shift.id,
        openedBy: "waiter-owner",
        status: "DRAFT",
      },
    });

    const otherWaiter = context(fixture, [fixture.locationAId]); // employeeId: "waiter-1"
    const floors = await tables.listTables(otherWaiter, fixture.locationAId);
    expect(floors[0].tables[0].activeOrderOwnerId).toBe("waiter-owner");
  });

  it("a table whose active order belongs to the CURRENT waiter exposes their own employeeId (not held-by-another)", async () => {
    const fixture = await createFixture();
    const shift = await prisma.shift.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationAId, openedBy: "waiter-1" },
    });
    await prisma.order.create({
      data: {
        restaurantId: fixture.restaurantId,
        locationId: fixture.locationAId,
        tableId: fixture.tableAId,
        shiftId: shift.id,
        openedBy: "waiter-1",
        status: "DRAFT",
      },
    });

    const owner = context(fixture, [fixture.locationAId]); // employeeId: "waiter-1"
    const floors = await tables.listTables(owner, fixture.locationAId);
    expect(floors[0].tables[0].activeOrderOwnerId).toBe("waiter-1");
  });

  it("a COMPLETED/CANCELLED order does not count as an active owner (table shows as free again)", async () => {
    const fixture = await createFixture();
    const shift = await prisma.shift.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationAId, openedBy: "waiter-owner" },
    });
    await prisma.order.create({
      data: {
        restaurantId: fixture.restaurantId,
        locationId: fixture.locationAId,
        tableId: fixture.tableAId,
        shiftId: shift.id,
        openedBy: "waiter-owner",
        status: "COMPLETED",
      },
    });

    const waiter = context(fixture, [fixture.locationAId]);
    const floors = await tables.listTables(waiter, fixture.locationAId);
    expect(floors[0].tables[0].activeOrderOwnerId).toBeNull();
  });

  it("SERVER-SIDE: a different waiter directly opening another waiter's DRAFT order via getOrder is still REJECTED (frontend popup is UX only, not the security boundary)", async () => {
    const fixture = await createFixture();
    const shift = await prisma.shift.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationAId, openedBy: "waiter-owner" },
    });
    const order = await prisma.order.create({
      data: {
        restaurantId: fixture.restaurantId,
        locationId: fixture.locationAId,
        tableId: fixture.tableAId,
        shiftId: shift.id,
        openedBy: "waiter-owner",
        status: "DRAFT",
      },
    });

    const intrudingWaiter = context(fixture, [fixture.locationAId]); // employeeId: "waiter-1"
    await expect(orders.getOrder(intrudingWaiter, order.id)).rejects.toThrow("Ovu porudžbinu je otvorio drugi konobar");
  });

  it("SERVER-SIDE: OWNER/ADMIN/MANAGER can still open any waiter's DRAFT order directly (management override unchanged)", async () => {
    const fixture = await createFixture();
    const shift = await prisma.shift.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationAId, openedBy: "waiter-owner" },
    });
    const order = await prisma.order.create({
      data: {
        restaurantId: fixture.restaurantId,
        locationId: fixture.locationAId,
        tableId: fixture.tableAId,
        shiftId: shift.id,
        openedBy: "waiter-owner",
        status: "DRAFT",
      },
    });

    const manager = context(fixture, [fixture.locationAId], "MANAGER");
    const fetched = await orders.getOrder(manager, order.id);
    expect(fetched.id).toBe(order.id);
  });
});
