import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { createSessionToken } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, settings as settingsDomain } from "@rcs/domain";
import { GET as getRestaurantSettingsRoute } from "../../apps/web/app/api/admin/settings/restaurant/route";
import { POST as printAuditRoute } from "../../apps/web/app/api/admin/reports/print-audit/route";
import { resetPrismaTestTables } from "../setup/reset-test-db";

/**
 * Audit fix (post-Phase-6 hardening) — dokazuje na nivou stvarne HTTP rute
 * (ne samo servisne funkcije) da:
 *
 * 1. GET /api/admin/settings/restaurant zahteva "settings.manage" —
 *    WAITER/KITCHEN/BAR dobijaju 403, OWNER/ADMIN/MANAGER 200.
 * 2. POST /api/admin/reports/print-audit zahteva "audit.view" — isti obrazac
 *    role/dozvole kao pristup samim finansijskim izveštajima.
 * 3. Nizak nivo `settings.getRestaurantSettings(ctx)` OSTAJE bez sopstvene
 *    provere dozvole (namerno — koristi ga interno svaki completePayment/
 *    dispatchReceiptPrintJob poziv, bez obzira ko je konobar) — provera je
 *    isključivo na ADMIN API ruti, ne u niskom čitaocu.
 */

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  menuItemId: string;
  roleIdByName: Record<string, string>;
}

// Isti raspored kao stvarni packages/db/prisma/seed.ts za permisije
// relevantne ovom testu (settings.manage/audit.view/orders.print/
// production.manage) — svedeno na ta 4 koda, ne ceo katalog.
const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: ["settings.manage", "audit.view", "orders.print"],
  ADMIN: ["settings.manage", "audit.view", "orders.print"],
  MANAGER: ["settings.manage", "audit.view", "orders.print"],
  WAITER: ["orders.print"],
  KITCHEN: ["production.manage"],
  BAR: ["production.manage"],
};
const PERMISSIONS = Array.from(new Set(Object.values(ROLE_PERMISSIONS).flat())).map((code) => ({ code, description: "" }));

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Admin API tenant", slug: `admin-api-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "seed-manager" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const menuItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Burger",
      slug: `burger-${randomUUID()}`,
      price: "1000.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });

  const permissions = await Promise.all(
    PERMISSIONS.map((p) => prisma.permission.upsert({ where: { code: p.code }, create: p, update: {} }))
  );
  const permissionByCode = Object.fromEntries(permissions.map((p) => [p.code, p]));

  const roleIdByName: Record<string, string> = {};
  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.create({ data: { restaurantId: restaurant.id, name: roleName, isSystem: true } });
    roleIdByName[roleName] = role.id;
    if (codes.length > 0) {
      await prisma.rolePermission.createMany({
        data: codes.map((code) => ({ roleId: role.id, permissionId: permissionByCode[code].id })),
      });
    }
  }

  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, menuItemId: menuItem.id, roleIdByName };
}

async function createEmployeeWithRole(fixture: Fixture, role: string, firstName: string) {
  const user = await prisma.user.create({ data: { username: `${randomUUID()}@test.local`, isActive: true } });
  const employee = await prisma.employee.create({
    data: { restaurantId: fixture.restaurantId, userId: user.id, firstName, lastName: role },
  });
  await prisma.employeeRole.create({ data: { employeeId: employee.id, roleId: fixture.roleIdByName[role] } });
  await prisma.employeeLocation.create({ data: { employeeId: employee.id, locationId: fixture.locationId } });
  const token = await createSessionToken({ userId: user.id, employeeId: employee.id, restaurantId: fixture.restaurantId });
  return { employee, token };
}

function domainContext(fixture: Fixture, role: string, employeeId: string): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(ROLE_PERMISSIONS[role] ?? []),
  };
}

function callSettingsRoute(token: string) {
  return getRestaurantSettingsRoute(
    new Request("http://localhost/api/admin/settings/restaurant", { headers: { cookie: `rcs_session=${token}` } }),
    { params: Promise.resolve({}) }
  );
}

function callPrintAuditRoute(token: string, body: unknown) {
  return printAuditRoute(
    new Request("http://localhost/api/admin/reports/print-audit", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `rcs_session=${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("GET /api/admin/settings/restaurant requires settings.manage, server-side", () => {
  it.each(["OWNER", "ADMIN", "MANAGER"])("allows %s (200)", async (role) => {
    const fixture = await createFixture();
    const { token } = await createEmployeeWithRole(fixture, role, role);
    const res = await callSettingsRoute(token);
    expect(res.status).toBe(200);
  });

  it.each(["WAITER", "KITCHEN", "BAR"])("forbids %s (403) — not just hidden in the admin UI", async (role) => {
    const fixture = await createFixture();
    const { token } = await createEmployeeWithRole(fixture, role, role);
    const res = await callSettingsRoute(token);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/reports/print-audit requires audit.view, server-side", () => {
  it.each(["OWNER", "ADMIN", "MANAGER"])("allows %s (200) for a supported reportType", async (role) => {
    const fixture = await createFixture();
    const { token } = await createEmployeeWithRole(fixture, role, role);
    const res = await callPrintAuditRoute(token, { reportType: "sales", preset: "today" });
    expect(res.status).toBe(200);
  });

  it.each(["WAITER", "KITCHEN", "BAR"])("forbids %s (403)", async (role) => {
    const fixture = await createFixture();
    const { token } = await createEmployeeWithRole(fixture, role, role);
    const res = await callPrintAuditRoute(token, { reportType: "sales", preset: "today" });
    expect(res.status).toBe(403);
  });

  it("never writes a report.printed audit entry when the caller lacks permission", async () => {
    const fixture = await createFixture();
    const { token } = await createEmployeeWithRole(fixture, "WAITER", "Waiter");
    await callPrintAuditRoute(token, { reportType: "sales", preset: "today" });
    const entry = await prisma.auditLog.findFirst({ where: { restaurantId: fixture.restaurantId, action: "report.printed" } });
    expect(entry).toBeNull();
  });

  it("rejects an unsupported reportType with 400, even for an authorized role", async () => {
    const fixture = await createFixture();
    const { token } = await createEmployeeWithRole(fixture, "OWNER", "Owner");
    const res = await callPrintAuditRoute(token, { reportType: "not-a-real-report", preset: "today" });
    expect(res.status).toBe(400);
  });
});

describe("printing still obtains restaurant settings internally, without settings.manage", () => {
  it("a WAITER (no settings.manage) can still complete payment, and the receipt PrintJob is correctly populated from RestaurantSettings", async () => {
    const fixture = await createFixture();
    // Restoran ima podešenu adresu/telefon — dokazuje da se STVARNO čitaju,
    // ne samo da dispatch "ne puca" u njihovom odsustvu.
    await prisma.restaurantSettings.create({
      data: { restaurantId: fixture.restaurantId, address: "Knez Mihailova 1", phone: "011-123-456" },
    });
    const { employee: waiterEmployee } = await createEmployeeWithRole(fixture, "WAITER", "Waiter");
    const waiterCtx = domainContext(fixture, "WAITER", waiterEmployee.id);
    expect(waiterCtx.permissions.has("settings.manage")).toBe(false);

    const order = await orders.openOrder(waiterCtx, { tableId: fixture.tableId });
    await orders.addItem(waiterCtx, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiterCtx, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiterCtx, submitted.id, { method: "CARD" });

    const printJob = await prisma.printJob.findFirstOrThrow({ where: { orderId: submitted.id, type: "RECEIPT" } });
    const content = printJob.content as { address: string | null; phone: string | null };
    expect(content.address).toBe("Knez Mihailova 1");
    expect(content.phone).toBe("011-123-456");
  });

  it("settings.getRestaurantSettings itself remains permission-free at the domain layer — the gate lives only in the admin API route", async () => {
    const fixture = await createFixture();
    const { employee: waiterEmployee } = await createEmployeeWithRole(fixture, "WAITER", "Waiter");
    const waiterCtx = domainContext(fixture, "WAITER", waiterEmployee.id);
    await expect(settingsDomain.getRestaurantSettings(waiterCtx)).resolves.toBeTruthy();
  });
});
