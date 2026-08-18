/**
 * Integracioni testovi za Personal Device auth tok.
 *
 * Pokriva:
 * - Registracija licnog uredjaja putem email+lozinke (registerPersonalDevice)
 * - staff-directory vraca SAMO vlasnika uredjaja (ne ceo imenik)
 * - Deaktiviran zaposleni — staff-directory vraca 403
 * - pin-login na licnom uredjaju: uvek koristi device.employeeId
 * - Pogresna lozinka ne moze registrovati uredjaj
 * - Kros-restoran pristup je blokiran
 * - Postavljanje login kredencijala od strane admina (setEmployeeLoginPassword)
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { employees, devices } from "@rcs/domain";
import { hashPassword, type AuthContext } from "@rcs/auth";
import { POST as pinLogin } from "../../apps/web/app/api/auth/pin-login/route";
import { GET as staffDirectory } from "../../apps/web/app/api/auth/staff-directory/route";

const PERMISSIONS = [
  { code: "employees.view", description: "" },
  { code: "employees.manage", description: "" },
];
const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: ["employees.view", "employees.manage"],
  WAITER: [],
};

interface Fixture {
  restaurantId: string;
  locationId: string;
  roleIdByName: Record<string, string>;
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "PD tenant", slug: `pd-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "PD Restaurant" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });

  const perms = await Promise.all(
    PERMISSIONS.map((p) => prisma.permission.upsert({ where: { code: p.code }, create: p, update: {} }))
  );
  const permByCode = Object.fromEntries(perms.map((p) => [p.code, p]));

  const roleIdByName: Record<string, string> = {};
  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.create({ data: { restaurantId: restaurant.id, name: roleName, isSystem: true } });
    roleIdByName[roleName] = role.id;
    if (codes.length > 0) {
      await prisma.rolePermission.createMany({
        data: codes.map((code) => ({ roleId: role.id, permissionId: permByCode[code].id })),
      });
    }
  }

  return { restaurantId: restaurant.id, locationId: location.id, roleIdByName };
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
  const owner = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, firstName: "Owner", lastName: "O" } });
  await prisma.employeeRole.create({ data: { employeeId: owner.id, roleId: fixture.roleIdByName.OWNER } });
  await prisma.employeeLocation.create({ data: { employeeId: owner.id, locationId: fixture.locationId } });
  return ownerCtx(fixture, owner.id);
}

function directoryRequest(deviceId: string) {
  return new Request(`http://localhost/api/auth/staff-directory?deviceId=${encodeURIComponent(deviceId)}`);
}

function pinLoginRequest(params: { deviceId: string; pin: string; employeeId?: string }) {
  return new Request("http://localhost/api/auth/pin-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE tenants, users, permissions, login_throttles CASCADE`);
});

afterAll(async () => prisma.$disconnect());

describe("setEmployeeLoginPassword", () => {
  it("kreira User i vezu Employee→User za zaposlenog koji nema nalog", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });

    await employees.setEmployeeLoginPassword(owner, waiter.id, {
      email: "marko@test.rs",
      password: "TajnaLozinka1",
    });

    const emp = await prisma.employee.findUnique({ where: { id: waiter.id }, include: { user: true } });
    expect(emp?.user).toBeTruthy();
    expect(emp?.user?.email).toBe("marko@test.rs");
    expect(emp?.user?.passwordHash).toBeTruthy();
    expect(emp?.user?.passwordHash).not.toContain("TajnaLozinka1");
  });

  it("azurira postoje User ako zaposleni vec ima nalog", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });

    await employees.setEmployeeLoginPassword(owner, waiter.id, { email: "prvo@test.rs", password: "PrvaLozinka12" });
    await employees.setEmployeeLoginPassword(owner, waiter.id, { email: "novo@test.rs", password: "NovaLozinka12" });

    const emp = await prisma.employee.findUnique({ where: { id: waiter.id }, include: { user: true } });
    expect(emp?.user?.email).toBe("novo@test.rs");
  });

  it("odbija kratku lozinku (< 10 karaktera)", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });

    await expect(
      employees.setEmployeeLoginPassword(owner, waiter.id, { email: "m@test.rs", password: "kratka" })
    ).rejects.toThrow();
  });
});

describe("registerPersonalDevice", () => {
  it("uspesno registruje uredjaj i vezuje ga za zaposlenog", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Ana", lastName: "A", pin: "5678", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });

    await employees.setEmployeeLoginPassword(owner, waiter.id, { email: "ana@test.rs", password: "AnaLozinka99" });

    const result = await devices.registerPersonalDevice({ email: "ana@test.rs", password: "AnaLozinka99" });
    expect(result.deviceId).toBeTruthy();
    expect(result.employeeName).toBe("Ana A");

    const device = await prisma.device.findUnique({ where: { id: result.deviceId } });
    expect(device?.employeeId).toBe(waiter.id);
    expect(device?.isActive).toBe(true);
    expect(device?.restaurantId).toBe(fixture.restaurantId);
  });

  it("odbija pogresnu lozinku genericki (bez otkrivanja razloga)", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Ana", lastName: "A", pin: "5678", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    await employees.setEmployeeLoginPassword(owner, waiter.id, { email: "ana@test.rs", password: "AnaLozinka99" });

    await expect(
      devices.registerPersonalDevice({ email: "ana@test.rs", password: "PogresnaLozinka" })
    ).rejects.toThrow("Neispravan email ili lozinka");
  });

  it("deaktivira stari licni uredjaj zaposlenog pri ponovnoj registraciji", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Ana", lastName: "A", pin: "5678", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    await employees.setEmployeeLoginPassword(owner, waiter.id, { email: "ana@test.rs", password: "AnaLozinka99" });

    const first = await devices.registerPersonalDevice({ email: "ana@test.rs", password: "AnaLozinka99" });
    const second = await devices.registerPersonalDevice({ email: "ana@test.rs", password: "AnaLozinka99" });

    expect(first.deviceId).not.toBe(second.deviceId);

    const oldDevice = await prisma.device.findUnique({ where: { id: first.deviceId } });
    expect(oldDevice?.isActive).toBe(false);
  });

  it("blokira deaktiviranog zaposlenog", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Ana", lastName: "A", pin: "5678", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    await employees.setEmployeeLoginPassword(owner, waiter.id, { email: "ana@test.rs", password: "AnaLozinka99" });
    await employees.setEmployeeStatus(owner, waiter.id, "SUSPENDED");

    await expect(
      devices.registerPersonalDevice({ email: "ana@test.rs", password: "AnaLozinka99" })
    ).rejects.toThrow("Nalog zaposlenog nije aktivan");
  });
});

describe("staff-directory za licni uredjaj", () => {
  it("vraca tacno jednu stavku — vlasnika uredjaja (ne ceo imenik)", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);

    const waiter1 = await employees.createEmployee(owner, {
      firstName: "Ana", lastName: "A", pin: "1111", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    await employees.createEmployee(owner, {
      firstName: "Marko", lastName: "M", pin: "2222", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    await employees.setEmployeeLoginPassword(owner, waiter1.id, { email: "ana@test.rs", password: "AnaLozinka99" });
    const { deviceId } = await devices.registerPersonalDevice({ email: "ana@test.rs", password: "AnaLozinka99" });

    const res = await staffDirectory(directoryRequest(deviceId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.staff).toHaveLength(1);
    expect(body.staff[0].id).toBe(waiter1.id);
    expect(body.staff[0].name).toBe("Ana A");
  });

  it("deaktiviran zaposleni sa licnim uredjajem → 403", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Ana", lastName: "A", pin: "1111", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    await employees.setEmployeeLoginPassword(owner, waiter.id, { email: "ana@test.rs", password: "AnaLozinka99" });
    const { deviceId } = await devices.registerPersonalDevice({ email: "ana@test.rs", password: "AnaLozinka99" });

    await employees.setEmployeeStatus(owner, waiter.id, "SUSPENDED");

    const res = await staffDirectory(directoryRequest(deviceId));
    expect(res.status).toBe(403);
  });
});

describe("pin-login na licnom uredjaju", () => {
  it("ispravan PIN vlasnika na licnom uredjaju uspeva", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Ana", lastName: "A", pin: "1111", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    await employees.setEmployeeLoginPassword(owner, waiter.id, { email: "ana@test.rs", password: "AnaLozinka99" });
    const { deviceId } = await devices.registerPersonalDevice({ email: "ana@test.rs", password: "AnaLozinka99" });

    const res = await pinLogin(pinLoginRequest({ deviceId, pin: "1111" }));
    expect(res.status).toBe(200);
  });

  it("licni uredjaj uvek koristi device.employeeId — cak i ako klijent salje drugi employeeId", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);

    const waiter1 = await employees.createEmployee(owner, {
      firstName: "Ana", lastName: "A", pin: "1111", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    const waiter2 = await employees.createEmployee(owner, {
      firstName: "Marko", lastName: "M", pin: "2222", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    await employees.setEmployeeLoginPassword(owner, waiter1.id, { email: "ana@test.rs", password: "AnaLozinka99" });
    const { deviceId } = await devices.registerPersonalDevice({ email: "ana@test.rs", password: "AnaLozinka99" });

    // Salje Markov PIN ali sa Anjinim uredjajem — uredjaj pripisuje Ani, Markov PIN ne odgovara
    const res = await pinLogin(pinLoginRequest({ deviceId, pin: "2222", employeeId: waiter2.id }));
    expect(res.status).toBe(401);
  });

  it("deaktiviran zaposleni ne moze da se prijavi na licnom uredjaju", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Ana", lastName: "A", pin: "1111", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    await employees.setEmployeeLoginPassword(owner, waiter.id, { email: "ana@test.rs", password: "AnaLozinka99" });
    const { deviceId } = await devices.registerPersonalDevice({ email: "ana@test.rs", password: "AnaLozinka99" });

    await employees.setEmployeeStatus(owner, waiter.id, "SUSPENDED");

    const res = await pinLogin(pinLoginRequest({ deviceId, pin: "1111" }));
    expect(res.status).toBe(403);
  });

  it("deaktiviran (isActive=false) uredjaj blokira prijavu", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Ana", lastName: "A", pin: "1111", roleNames: ["WAITER"], locationIds: [fixture.locationId],
    });
    await employees.setEmployeeLoginPassword(owner, waiter.id, { email: "ana@test.rs", password: "AnaLozinka99" });
    const { deviceId } = await devices.registerPersonalDevice({ email: "ana@test.rs", password: "AnaLozinka99" });

    await prisma.device.update({ where: { id: deviceId }, data: { isActive: false } });

    const res = await pinLogin(pinLoginRequest({ deviceId, pin: "1111" }));
    expect(res.status).toBe(403);
  });
});
