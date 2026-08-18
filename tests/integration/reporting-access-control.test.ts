import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { reporting } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
}

function context(fixture: Fixture, role: string, employeeId: string, permissions: string[]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(permissions),
  };
}

// Isti permission-set kao stvarni seed (packages/db/prisma/seed.ts) — OWNER/
// ADMIN/MANAGER dobijaju audit.view, WAITER/KITCHEN/BAR ne dobijaju.
const MANAGEMENT_PERMISSIONS = ["audit.view"];
const WAITER_PERMISSIONS = ["menu.view", "shifts.manage", "orders.print"];
const STATION_PERMISSIONS = ["menu.view", "production.view", "production.manage"];

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Access tenant", slug: `access-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

afterAll(async () => prisma.$disconnect());

describe("reporting access control: only OWNER/ADMIN/MANAGER reach financial reports", () => {
  it.each(["OWNER", "ADMIN", "MANAGER"])("%s can call getSalesSummary, getDailySummary, and export-backing report functions", async (role) => {
    const fixture = await createFixture();
    const ctx = context(fixture, role, `emp-${role}`, MANAGEMENT_PERMISSIONS);

    await expect(reporting.getSalesSummary(ctx, { locationId: "ALL", preset: "today" })).resolves.toBeTruthy();
    await expect(reporting.getDailySummary(ctx, { locationId: "ALL", preset: "today" })).resolves.toBeTruthy();
    await expect(reporting.getSalesSummaryThermal(ctx, { locationId: "ALL", preset: "today" })).resolves.toBeTruthy();
    await expect(reporting.getSoldItems(ctx, { locationId: "ALL", preset: "today" })).resolves.toBeTruthy();
    await expect(reporting.getShiftReport(ctx, { locationId: "ALL", preset: "today" })).resolves.toBeTruthy();
    await expect(reporting.getEmployeeActivity(ctx, { locationId: "ALL", preset: "today" })).resolves.toBeTruthy();
  });

  it.each(["WAITER", "KITCHEN", "BAR"])("%s is rejected from every financial report function", async (role) => {
    const fixture = await createFixture();
    const permissions = role === "WAITER" ? WAITER_PERMISSIONS : STATION_PERMISSIONS;
    const ctx = context(fixture, role, `emp-${role}`, permissions);

    await expect(reporting.getSalesSummary(ctx, { locationId: "ALL", preset: "today" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reporting.getDailySummary(ctx, { locationId: "ALL", preset: "today" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reporting.getSoldItems(ctx, { locationId: "ALL", preset: "today" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reporting.getShiftReport(ctx, { locationId: "ALL", preset: "today" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reporting.getEmployeeActivity(ctx, { locationId: "ALL", preset: "today" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reporting.getVoidReport(ctx, { locationId: "ALL", preset: "today" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects cross-restaurant report access — a manager in Restaurant B cannot target Restaurant A's location", async () => {
    const fixture = await createFixture();
    const outsider = context(fixture, "MANAGER", "outsider", MANAGEMENT_PERMISSIONS);
    outsider.restaurantId = fixture.otherRestaurantId;
    outsider.locationIds = []; // menadžer restorana B nema pristup nijednoj lokaciji restorana A

    await expect(
      reporting.getSalesSummary(outsider, { locationId: fixture.locationId, preset: "today" })
    ).rejects.toBeInstanceOf(ForbiddenError);

    // I "ALL" (bez eksplicitnog locationId pokušaja) vraća PRAZNO za restoran
    // bez ijedne dodeljene lokacije — nikad tuđe podatke kao fallback.
    await expect(reporting.listAccessibleLocations(outsider)).resolves.toEqual([]);
  });

  it("rejects an explicit locationId the caller does not have access to", async () => {
    const fixture = await createFixture();
    const otherLocation = await prisma.location.create({ data: { restaurantId: fixture.restaurantId, name: "Other" } });
    const ctx = context(fixture, "MANAGER", "mgr-1", MANAGEMENT_PERMISSIONS); // locationIds = [fixture.locationId] only

    await expect(
      reporting.getSalesSummary(ctx, { locationId: otherLocation.id, preset: "today" })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("supports the new thisWeek/lastWeek/thisMonth/lastMonth/thisYear presets without error", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture, "OWNER", "owner-1", MANAGEMENT_PERMISSIONS);

    for (const preset of ["thisWeek", "lastWeek", "thisMonth", "lastMonth", "thisYear"] as const) {
      await expect(reporting.getSalesSummary(ctx, { locationId: "ALL", preset })).resolves.toBeTruthy();
    }
  });
});
