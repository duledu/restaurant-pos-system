import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { employees } from "@rcs/domain";
import { hashPin, type AuthContext } from "@rcs/auth";
import { POST as pinLogin } from "../../apps/web/app/api/auth/pin-login/route";
import { GET as staffDirectory } from "../../apps/web/app/api/auth/staff-directory/route";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  deviceId: string;
  roleIdByName: Record<string, string>;
}

// Isti obrazac kao ostali integration testovi (staff-management.test.ts,
// shared-pos-lock.test.ts) — svaki fajl gradi svoj skup permisija/rola.
const PERMISSIONS = [
  { code: "employees.view", description: "" },
  { code: "employees.manage", description: "" },
];
const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: ["employees.view", "employees.manage"],
  WAITER: [],
  KITCHEN: [],
};

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Directory tenant", slug: `dir-${randomUUID()}` } });
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
  await prisma.role.create({ data: { restaurantId: otherRestaurant.id, name: "WAITER", isSystem: true } });

  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    deviceId: device.id,
    roleIdByName,
  };
}

function ownerCtx(fixture: Fixture, employeeId: string): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["OWNER"],
    permissions: new Set(ROLE_PERMISSIONS.OWNER),
  };
}

async function createOwner(fixture: Fixture) {
  const owner = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, firstName: "Owner", lastName: "One" } });
  await prisma.employeeRole.create({ data: { employeeId: owner.id, roleId: fixture.roleIdByName.OWNER } });
  await prisma.employeeLocation.create({ data: { employeeId: owner.id, locationId: fixture.locationId } });
  return ownerCtx(fixture, owner.id);
}

function directoryRequest(deviceId: string) {
  return new Request(`http://localhost/api/auth/staff-directory?deviceId=${encodeURIComponent(deviceId)}`);
}

function pinLoginRequest(params: { deviceId: string; pin: string; employeeId: string }) {
  return () =>
    new Request("http://localhost/api/auth/pin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

afterAll(async () => prisma.$disconnect());

describe("staff login directory: scoping", () => {
  it("lists only ACTIVE, PIN-eligible employees for the device's own restaurant", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "Marković", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    await employees.createEmployee(owner, { firstName: "Suspendovan", lastName: "S", pin: "9999", roleNames: ["WAITER"], locationIds: [fixture.locationId] }).then((e) =>
      employees.setEmployeeStatus(owner, e.id, "SUSPENDED")
    );

    const res = await staffDirectory(directoryRequest(fixture.deviceId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.staff).toHaveLength(1);
    expect(body.staff[0].id).toBe(marko.id);
    expect(body.staff[0].name).toBe("Marko Marković");
    expect(body.staff[0].role).toBe("WAITER");
  });

  it("excludes employees who belong to a different restaurant", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    const otherTenant = await prisma.tenant.create({ data: { name: "T2", slug: `t2-${randomUUID()}` } });
    const restaurantB = await prisma.restaurant.create({ data: { tenantId: otherTenant.id, name: "Restaurant C" } });
    const locationB = await prisma.location.create({ data: { restaurantId: restaurantB.id, name: "Main B" } });
    const deviceB = await prisma.device.create({ data: { restaurantId: restaurantB.id, locationId: locationB.id, name: "POS-B" } });

    const res = await staffDirectory(directoryRequest(deviceB.id));
    const body = await res.json();
    expect(body.staff).toHaveLength(0); // ne vidi Marka iz restorana A
  });

  it("excludes employees assigned only to a different location within the same restaurant", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [fixture.otherLocationId], // NE glavna lokacija gde je uređaj
    });

    const res = await staffDirectory(directoryRequest(fixture.deviceId));
    const body = await res.json();
    expect(body.staff).toHaveLength(0);
  });

  it("returns only id/name/role — no email, pinHash, lockout data, or userId", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    const res = await staffDirectory(directoryRequest(fixture.deviceId));
    const body = await res.json();
    const entry = body.staff[0];
    expect(Object.keys(entry).sort()).toEqual(["id", "name", "role"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("pinHash");
    expect(serialized).not.toContain("failedPinAttempts");
    expect(serialized).not.toContain("pinLockedUntil");
    expect(serialized).not.toContain("userId");
  });

  it("rejects an unregistered/unknown deviceId", async () => {
    const res = await staffDirectory(directoryRequest(randomUUID()));
    expect(res.status).toBe(403);
  });

  it("rejects a request with no deviceId", async () => {
    const res = await staffDirectory(new Request("http://localhost/api/auth/staff-directory"));
    expect(res.status).toBe(400);
  });
});

describe("staff login directory: authentication chain (employee + PIN)", () => {
  it("correct employee + correct PIN succeeds", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    const res = await pinLogin(pinLoginRequest({ employeeId: marko.id, pin: "1234", deviceId: fixture.deviceId })());
    expect(res.status).toBe(200);
  });

  it("correct employee + wrong PIN fails", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    const res = await pinLogin(pinLoginRequest({ employeeId: marko.id, pin: "0000", deviceId: fixture.deviceId })());
    expect(res.status).toBe(401);
  });

  it("selecting employee A but entering employee B's real PIN fails (selection alone never authenticates)", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    await employees.createEmployee(owner, { firstName: "Jovan", lastName: "J", pin: "5678", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    const res = await pinLogin(pinLoginRequest({ employeeId: marko.id, pin: "5678", deviceId: fixture.deviceId })());
    expect(res.status).toBe(401);
  });

  it("rejects a manually-submitted employeeId belonging to a suspended employee", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    await employees.setEmployeeStatus(owner, marko.id, "SUSPENDED");

    const res = await pinLogin(pinLoginRequest({ employeeId: marko.id, pin: "1234", deviceId: fixture.deviceId })());
    expect(res.status).toBe(403);
  });

  it("rejects a manually-submitted employeeId belonging to another restaurant's employee", async () => {
    const fixture = await createFixture();

    const otherTenant = await prisma.tenant.create({ data: { name: "T2", slug: `t2-${randomUUID()}` } });
    const restaurantB = await prisma.restaurant.create({ data: { tenantId: otherTenant.id, name: "Restaurant C" } });
    const roleB = await prisma.role.create({ data: { restaurantId: restaurantB.id, name: "WAITER", isSystem: true } });
    const foreignEmployee = await prisma.employee.create({
      data: { restaurantId: restaurantB.id, firstName: "Foreign", lastName: "F", pinHash: await hashPin("1111") },
    });
    await prisma.employeeRole.create({ data: { employeeId: foreignEmployee.id, roleId: roleB.id } });

    // Restoran A uređaj pokušava da autentifikuje zaposlenog iz restorana B —
    // mora pasti bez obzira što je PIN "ispravan" za tog zaposlenog, jer
    // device.restaurantId ne odgovara employee.restaurantId.
    const res = await pinLogin(pinLoginRequest({ employeeId: foreignEmployee.id, pin: "1111", deviceId: fixture.deviceId })());
    expect(res.status).toBe(401);
  });
});
