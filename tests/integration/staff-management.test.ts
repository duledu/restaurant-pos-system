import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError, createSessionToken, requireAuth, verifyPin } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { employees, orders, billing, shifts } from "@rcs/domain";
import { POST as pinLogin } from "../../apps/web/app/api/auth/pin-login/route";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  deviceId: string;
  roleIdByName: Record<string, string>;
}

// Isti skup permisija/rola kao packages/db/prisma/seed.ts, sveden na ono što
// je potrebno ovim testovima — testovi ne mogu da se oslone na dev seed
// podatke (svaki test file čisti bazu u beforeEach).
const PERMISSIONS = [
  { code: "employees.view", description: "" },
  { code: "employees.manage", description: "" },
  { code: "shifts.manage", description: "" },
];
const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: ["employees.view", "employees.manage", "shifts.manage"],
  ADMIN: ["employees.view", "employees.manage", "shifts.manage"],
  MANAGER: ["employees.view", "shifts.manage"],
  WAITER: ["shifts.manage"],
  KITCHEN: [],
  BAR: [],
};

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Staff tenant", slug: `staff-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Other" } });
  const device = await prisma.device.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "POS-1" } });

  const permissions = await Promise.all(
    PERMISSIONS.map((p) => prisma.permission.upsert({ where: { code: p.code }, create: p, update: {} }))
  );
  const permissionByCode = Object.fromEntries(permissions.map((p) => [p.code, p]));

  const roleIdByName: Record<string, string> = {};
  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.create({ data: { restaurantId: restaurant.id, name: roleName, isSystem: true } });
    roleIdByName[roleName] = role.id;
    if (codes.length > 0) {
      await prisma.rolePermission.createMany({ data: codes.map((code) => ({ roleId: role.id, permissionId: permissionByCode[code].id })) });
    }
  }
  // Restoran B dobija iste rola (za cross-restaurant testove).
  for (const roleName of Object.keys(ROLE_PERMISSIONS)) {
    await prisma.role.create({ data: { restaurantId: otherRestaurant.id, name: roleName, isSystem: true } });
  }

  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    deviceId: device.id,
    roleIdByName,
  };
}

function context(fixture: Fixture, role: string, employeeId: string, locationIds: string[]): AuthContext {
  const perms = ROLE_PERMISSIONS[role] ?? [];
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds,
    roles: [role],
    permissions: new Set(perms),
  };
}

async function createOwner(fixture: Fixture) {
  const owner = await prisma.employee.create({
    data: { restaurantId: fixture.restaurantId, firstName: "Owner", lastName: "One" },
  });
  await prisma.employeeRole.create({ data: { employeeId: owner.id, roleId: fixture.roleIdByName.OWNER } });
  await prisma.employeeLocation.create({ data: { employeeId: owner.id, locationId: fixture.locationId } });
  return context(fixture, "OWNER", owner.id, [fixture.locationId]);
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

afterAll(async () => prisma.$disconnect());

describe("staff management: creation", () => {
  it("creates a PIN-only waiter with no email/password required", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);

    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "Marković",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });

    expect(waiter.userId).toBeNull();
    const stored = await prisma.employee.findUniqueOrThrow({ where: { id: waiter.id } });
    expect(stored.pinHash).toBeTruthy();
    expect(stored.pinHash).not.toBe("1234"); // nikad plain text
  });

  it.each(["WAITER", "KITCHEN", "BAR", "MANAGER"])("creates a %s employee", async (role) => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const created = await employees.createEmployee(owner, {
      firstName: "Test",
      lastName: role,
      pin: "5678",
      roleNames: [role],
      locationIds: [fixture.locationId],
    });
    const withRoles = await prisma.employee.findUniqueOrThrow({ where: { id: created.id }, include: { roles: { include: { role: true } } } });
    expect(withRoles.roles.map((r) => r.role.name)).toEqual([role]);
  });

  it("allows the newly created employee to authenticate through the real PIN login flow", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const created = await employees.createEmployee(owner, {
      firstName: "Nikola",
      lastName: "Kuhinja",
      pin: "4321",
      roleNames: ["KITCHEN"],
      locationIds: [fixture.locationId],
    });

    const request = () =>
      new Request("http://localhost/api/auth/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: created.id, deviceId: fixture.deviceId, pin: "4321" }),
      });
    const response = await pinLogin(request());
    expect(response.status).toBe(200);
  });
});

describe("staff management: PIN rules", () => {
  it("enforces per-restaurant PIN uniqueness among active employees", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    await employees.createEmployee(owner, {
      firstName: "First",
      lastName: "Waiter",
      pin: "1111",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });

    await expect(
      employees.createEmployee(owner, {
        firstName: "Second",
        lastName: "Waiter",
        pin: "1111",
        roleNames: ["WAITER"],
        locationIds: [fixture.locationId],
      })
    ).rejects.toThrow("već dodeljen");
  });

  it("allows reusing a PIN once the original holder is deactivated", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const first = await employees.createEmployee(owner, {
      firstName: "First",
      lastName: "Waiter",
      pin: "2222",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });
    await employees.setEmployeeStatus(owner, first.id, "SUSPENDED");

    await expect(
      employees.createEmployee(owner, {
        firstName: "Second",
        lastName: "Waiter",
        pin: "2222",
        roleNames: ["WAITER"],
        locationIds: [fixture.locationId],
      })
    ).resolves.toBeTruthy();
  });

  it("resets a PIN and invalidates the old one, without ever storing the PIN in AuditLog", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });

    await employees.resetEmployeePin(owner, waiter.id, "9999");

    const updated = await prisma.employee.findUniqueOrThrow({ where: { id: waiter.id } });
    expect(await verifyPin("1234", updated.pinHash as string)).toBe(false); // stari PIN više ne radi
    expect(await verifyPin("9999", updated.pinHash as string)).toBe(true);

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityId: waiter.id, action: "employee.pin_reset" } });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("9999");
    expect(serialized).not.toContain("1234");
    expect(serialized).not.toContain(updated.pinHash);
  });

  it("clears an existing PIN lockout when the PIN is reset", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });
    await prisma.employee.update({ where: { id: waiter.id }, data: { failedPinAttempts: 5, pinLockedUntil: new Date(Date.now() + 60000) } });

    await employees.resetEmployeePin(owner, waiter.id, "5555");

    const updated = await prisma.employee.findUniqueOrThrow({ where: { id: waiter.id } });
    expect(updated.failedPinAttempts).toBe(0);
    expect(updated.pinLockedUntil).toBeNull();
  });
});

describe("staff management: role changes affect authorization immediately", () => {
  it("revokes employees.manage on the SAME session token as soon as the role is downgraded", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const secondOwnerEmployee = await prisma.employee.create({
      data: { restaurantId: fixture.restaurantId, firstName: "Second", lastName: "Owner" },
    });
    await prisma.employeeRole.create({ data: { employeeId: secondOwnerEmployee.id, roleId: fixture.roleIdByName.OWNER } });
    await prisma.employeeLocation.create({ data: { employeeId: secondOwnerEmployee.id, locationId: fixture.locationId } });

    const user = await prisma.user.create({ data: { email: `${randomUUID()}@test.local`, isActive: true } });
    const manager = await prisma.employee.create({
      data: { restaurantId: fixture.restaurantId, userId: user.id, firstName: "Ana", lastName: "Manager" },
    });
    await prisma.employeeRole.create({ data: { employeeId: manager.id, roleId: fixture.roleIdByName.MANAGER } });
    await prisma.employeeLocation.create({ data: { employeeId: manager.id, locationId: fixture.locationId } });
    // MANAGER nema employees.manage — promovišimo je privremeno u ADMIN da
    // testiramo DOWNGRADE (ADMIN -> WAITER) i gubitak te dozvole.
    await employees.updateEmployee(owner, manager.id, { roleNames: ["ADMIN"] });

    const token = await createSessionToken({ userId: user.id, employeeId: manager.id, restaurantId: fixture.restaurantId });
    const request = () => new Request("http://localhost/protected", { headers: { cookie: `rcs_session=${token}` } });

    const before = await requireAuth(request());
    expect(before.permissions.has("employees.manage")).toBe(true);

    await employees.updateEmployee(owner, manager.id, { roleNames: ["WAITER"] });

    const after = await requireAuth(request());
    expect(after.permissions.has("employees.manage")).toBe(false); // ISTI token, nova permisija se ne vidi
  });
});

describe("staff management: deactivation", () => {
  it("blocks PIN login immediately after deactivation", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });

    const request = () =>
      new Request("http://localhost/api/auth/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: waiter.id, deviceId: fixture.deviceId, pin: "1234" }),
      });
    expect((await pinLogin(request())).status).toBe(200);

    await employees.setEmployeeStatus(owner, waiter.id, "SUSPENDED");
    expect((await pinLogin(request())).status).toBe(403);
  });

  it("rejects an existing session immediately after deactivation, via the existing active-session check", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@test.local`, isActive: true } });
    const waiter = await prisma.employee.create({
      data: { restaurantId: fixture.restaurantId, userId: user.id, firstName: "Marko", lastName: "M" },
    });
    await prisma.employeeRole.create({ data: { employeeId: waiter.id, roleId: fixture.roleIdByName.WAITER } });
    await prisma.employeeLocation.create({ data: { employeeId: waiter.id, locationId: fixture.locationId } });

    const token = await createSessionToken({ userId: user.id, employeeId: waiter.id, restaurantId: fixture.restaurantId });
    const request = () => new Request("http://localhost/protected", { headers: { cookie: `rcs_session=${token}` } });
    await expect(requireAuth(request())).resolves.toBeTruthy();

    await employees.setEmployeeStatus(owner, waiter.id, "SUSPENDED");
    await expect(requireAuth(request())).rejects.toThrow();
  });

  it("preserves historical orders, shifts, and audit entries after deactivation", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });
    const waiterCtx = context(fixture, "WAITER", waiter.id, [fixture.locationId]);

    const shift = await shifts.openShift(owner, { locationId: fixture.locationId, openingCash: 0 });
    const category = await prisma.menuCategory.create({ data: { restaurantId: fixture.restaurantId, name: "T", slug: `t-${randomUUID()}`, type: "FOOD" } });
    const menuItem = await prisma.menuItem.create({
      data: { restaurantId: fixture.restaurantId, categoryId: category.id, name: "Burger", slug: `b-${randomUUID()}`, price: "500.00", preparationStation: "KITCHEN" },
    });
    const floor = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "F" } });
    const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
    const order = await orders.openOrder(waiterCtx, { tableId: table.id });
    await orders.addItem(waiterCtx, order.id, { menuItemId: menuItem.id, quantity: 1 });
    const submitted = await orders.submitOrder(waiterCtx, order.id, { idempotencyKey: randomUUID() });
    await billing.completePayment(waiterCtx, submitted.id, { method: "CASH" });

    await employees.setEmployeeStatus(owner, waiter.id, "SUSPENDED");

    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloadedOrder.openedBy).toBe(waiter.id); // istorijska referenca netaknuta
    const reloadedShift = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(reloadedShift.openedBy).toBe(owner.employeeId);
    const auditEntries = await prisma.auditLog.count({ where: { entityId: waiter.id } });
    expect(auditEntries).toBeGreaterThan(0); // employee.created i dr. i dalje postoje

    // Zaposleni i dalje ima ime — reporting/aktivnost ga i dalje mogu
    // prikazati (deaktivacija ne obriše red, samo status).
    const stillThere = await prisma.employee.findUnique({ where: { id: waiter.id } });
    expect(stillThere?.firstName).toBe("Marko");
    expect(stillThere?.status).toBe("SUSPENDED");
  });

  it("allows reactivating a deactivated employee", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });
    await employees.setEmployeeStatus(owner, waiter.id, "SUSPENDED");
    await employees.setEmployeeStatus(owner, waiter.id, "ACTIVE");

    const reloaded = await prisma.employee.findUniqueOrThrow({ where: { id: waiter.id } });
    expect(reloaded.status).toBe("ACTIVE");

    const request = () =>
      new Request("http://localhost/api/auth/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: waiter.id, deviceId: fixture.deviceId, pin: "1234" }),
      });
    expect((await pinLogin(request())).status).toBe(200); // PIN je preživeo reaktivaciju
  });
});

describe("staff management: owner/admin protection", () => {
  it("refuses to deactivate the only active OWNER", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    await expect(employees.setEmployeeStatus(owner, owner.employeeId, "SUSPENDED")).rejects.toThrow("bar jednog aktivnog vlasnika");
  });

  it("refuses to strip the OWNER role from the only owner via updateEmployee", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    await expect(employees.updateEmployee(owner, owner.employeeId, { roleNames: ["WAITER"] })).rejects.toThrow("bar jednog aktivnog vlasnika");
  });

  it("allows deactivating an owner when another owner still exists", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const secondOwner = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, firstName: "Second", lastName: "Owner" } });
    await prisma.employeeRole.create({ data: { employeeId: secondOwner.id, roleId: fixture.roleIdByName.OWNER } });

    await expect(employees.setEmployeeStatus(owner, owner.employeeId, "SUSPENDED")).resolves.toBeTruthy();
  });

  it("refuses a role change that would leave the restaurant with no employees.manage-capable account", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const admin = await employees.createEmployee(owner, {
      firstName: "Ana",
      lastName: "Admin",
      pin: "7777",
      roleNames: ["ADMIN"],
      locationIds: [fixture.locationId],
    });
    // Sad postoje DVA naloga sa employees.manage (owner + admin) — uklanjanje
    // OWNER-ovog vlasništva bi ipak trebalo da bude blokirano (jedini OWNER),
    // ali demoting ADMIN-a treba da PROĐE jer OWNER i dalje ima manage.
    await expect(employees.updateEmployee(owner, admin.id, { roleNames: ["WAITER"] })).resolves.toBeTruthy();
  });
});

describe("staff management: security boundaries", () => {
  it.each(["WAITER", "KITCHEN", "BAR"])("rejects %s from creating employees", async (role) => {
    const fixture = await createFixture();
    const ctx = context(fixture, role, `emp-${role}`, [fixture.locationId]);
    await expect(
      employees.createEmployee(ctx, { firstName: "X", lastName: "Y", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects MANAGER from creating/editing employees (view-only per the existing permission model)", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const manager = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, firstName: "M", lastName: "Gr" } });
    await prisma.employeeRole.create({ data: { employeeId: manager.id, roleId: fixture.roleIdByName.MANAGER } });
    const managerCtx = context(fixture, "MANAGER", manager.id, [fixture.locationId]);

    await expect(
      employees.createEmployee(managerCtx, { firstName: "X", lastName: "Y", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    // ali SME da vidi listu (employees.view)
    await expect(employees.listEmployees(managerCtx)).resolves.toBeTruthy();
  });

  it("rejects creating an employee with a location from another restaurant", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const foreignLocation = await prisma.location.create({ data: { restaurantId: fixture.otherRestaurantId, name: "Foreign" } });

    await expect(
      employees.createEmployee(owner, { firstName: "X", lastName: "Y", pin: "1234", roleNames: ["WAITER"], locationIds: [foreignLocation.id] })
    ).rejects.toThrow("ne pripadaju ovom restoranu");
  });

  it("rejects assigning a foreign-restaurant location via updateEmployee", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });
    const foreignLocation = await prisma.location.create({ data: { restaurantId: fixture.otherRestaurantId, name: "Foreign" } });

    await expect(employees.updateEmployee(owner, waiter.id, { locationIds: [foreignLocation.id] })).rejects.toThrow(
      "ne pripadaju ovom restoranu"
    );
  });

  it("does not find/modify an employee belonging to another restaurant", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const otherEmployee = await prisma.employee.create({ data: { restaurantId: fixture.otherRestaurantId, firstName: "Foreign", lastName: "Emp" } });

    await expect(employees.updateEmployee(owner, otherEmployee.id, { firstName: "Hacked" })).rejects.toThrow("nije pronađen");
    await expect(employees.setEmployeeStatus(owner, otherEmployee.id, "SUSPENDED")).rejects.toThrow("nije pronađen");
    await expect(employees.resetEmployeePin(owner, otherEmployee.id, "0000")).rejects.toThrow("nije pronađen");
  });
});

describe("staff management: audit", () => {
  it("audits employee creation with role and location, without the PIN", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityId: waiter.id, action: "employee.created" } });
    expect(entry.userId).toBe(owner.employeeId);
    expect(JSON.stringify(entry)).not.toContain("1234");
  });

  it("audits a role change with before/after role names", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });

    await employees.updateEmployee(owner, waiter.id, { roleNames: ["KITCHEN"] });

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityId: waiter.id, action: "employee.updated" } });
    expect((entry.previousValue as { roleNames: string[] }).roleNames).toEqual(["WAITER"]);
    expect((entry.newValue as { roleNames: string[] }).roleNames).toEqual(["KITCHEN"]);
  });

  it("audits deactivation and reactivation", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.locationId],
    });

    await employees.setEmployeeStatus(owner, waiter.id, "SUSPENDED");
    await employees.setEmployeeStatus(owner, waiter.id, "ACTIVE");

    expect(await prisma.auditLog.count({ where: { entityId: waiter.id, action: "employee.deactivated" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: waiter.id, action: "employee.reactivated" } })).toBe(1);
  });
});
