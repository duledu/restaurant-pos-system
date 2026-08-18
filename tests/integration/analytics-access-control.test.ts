import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { analytics } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
}

// Isti permission-set kao stvarni seed (packages/db/prisma/seed.ts) —
// analitika koristi ISTU "audit.view" permisiju kao postojeći izveštaji
// (namerno, vidi analytics-service.ts header — nema nove permisije).
const MANAGEMENT_PERMISSIONS = ["audit.view"];
const WAITER_PERMISSIONS = ["menu.view", "shifts.manage", "orders.print"];
const STATION_PERMISSIONS = ["menu.view", "production.view", "production.manage"];

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

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Analytics access tenant", slug: `analytics-access-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

afterAll(async () => prisma.$disconnect());

describe("analytics access control: only OWNER/ADMIN/MANAGER reach BI endpoints", () => {
  it.each(["OWNER", "ADMIN", "MANAGER"])("%s can call every analytics function", async (role) => {
    const fixture = await createFixture();
    const ctx = context(fixture, role, `emp-${role}`, MANAGEMENT_PERMISSIONS);
    const filters = { locationId: "ALL", preset: "today" } as const;

    await expect(analytics.getKpiComparison(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getSalesTrend(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getSalesByHour(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getSalesByWeekday(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getStationComparison(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getTopAndLowItems(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getCategoryPerformance(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getEmployeePerformance(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getEmployeeNormalizedMetrics(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getVoidIntelligence(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getDiscountIntelligence(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getPaymentBreakdown(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getShiftAnalytics(ctx, filters)).resolves.toBeTruthy();
    await expect(analytics.getInsights(ctx, filters)).resolves.toBeTruthy();
  });

  it.each(["WAITER", "KITCHEN", "BAR"])("%s is rejected from every analytics function", async (role) => {
    const fixture = await createFixture();
    const permissions = role === "WAITER" ? WAITER_PERMISSIONS : STATION_PERMISSIONS;
    const ctx = context(fixture, role, `emp-${role}`, permissions);
    const filters = { locationId: "ALL", preset: "today" } as const;

    await expect(analytics.getKpiComparison(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getSalesTrend(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getSalesByHour(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getSalesByWeekday(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getStationComparison(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getTopAndLowItems(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getCategoryPerformance(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getEmployeePerformance(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getEmployeeNormalizedMetrics(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getVoidIntelligence(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getDiscountIntelligence(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getPaymentBreakdown(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getShiftAnalytics(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(analytics.getInsights(ctx, filters)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects cross-restaurant analytics access — a manager in Restaurant B cannot target Restaurant A's location", async () => {
    const fixture = await createFixture();
    const outsider = context(fixture, "MANAGER", "outsider", MANAGEMENT_PERMISSIONS);
    outsider.restaurantId = fixture.otherRestaurantId;
    outsider.locationIds = [];

    await expect(
      analytics.getKpiComparison(outsider, { locationId: fixture.locationId, preset: "today" })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("restaurantId always comes from ctx, never from a client-supplied filter value", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture, "MANAGER", "mgr-1", MANAGEMENT_PERMISSIONS);
    // "filters" nema restaurantId polje uopšte — potvrđuje da API oblik ne
    // dozvoljava klijentu da ga uopšte pošalje; scope dolazi isključivo iz ctx.
    const result = await analytics.getKpiComparison(ctx, { locationId: "ALL", preset: "today" });
    expect(result.current.currency).toBe("RSD");
  });
});
