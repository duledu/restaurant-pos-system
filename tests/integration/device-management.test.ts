/**
 * Admin Device Management.
 *
 * Pokriva: RBAC (OWNER/ADMIN/MANAGER upravljaju, ostali ne), izolaciju po
 * restoranu (listanje/preimenovanje/opoziv/reaktivacija), da opoziv blokira
 * NOVU PIN prijavu (već postojeće ponašanje) I VEĆ IZDATU sesiju (novi
 * bezbednosni fix u requireAuth), da reaktivacija vraća normalnu validnost,
 * da sesije BEZ deviceId-a rade nepromenjeno, da preimenovanje ne menja
 * registracioni identitet, throttled lastSeenAt upis, i audit zapise.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError, UnauthorizedError, createSessionToken, requireAuth } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { devices } from "@rcs/domain";
import { POST as pinLogin } from "../../apps/web/app/api/auth/pin-login/route";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  roleIdByName: Record<string, string>;
  otherRoleIdByName: Record<string, string>;
}

const PERMISSIONS = [
  { code: "devices.manage", description: "" },
  { code: "shifts.manage", description: "" },
];
const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: ["devices.manage", "shifts.manage"],
  ADMIN: ["devices.manage", "shifts.manage"],
  MANAGER: ["devices.manage", "shifts.manage"],
  WAITER: ["shifts.manage"],
  KITCHEN: [],
  BAR: [],
};

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Device tenant", slug: `dev-mgmt-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: otherRestaurant.id, name: "Main B" } });

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
  const otherRoleIdByName: Record<string, string> = {};
  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.create({ data: { restaurantId: otherRestaurant.id, name: roleName, isSystem: true } });
    otherRoleIdByName[roleName] = role.id;
    if (codes.length > 0) {
      await prisma.rolePermission.createMany({ data: codes.map((code) => ({ roleId: role.id, permissionId: permissionByCode[code].id })) });
    }
  }

  return {
    restaurantId: restaurant.id,
    otherRestaurantId: otherRestaurant.id,
    locationId: location.id,
    roleIdByName,
    otherRoleIdByName,
  };
}

function context(fixture: Fixture, role: string, employeeId: string, restaurantId = fixture.restaurantId): AuthContext {
  const perms = ROLE_PERMISSIONS[role] ?? [];
  return {
    userId: employeeId,
    employeeId,
    restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(perms),
  };
}

async function createEmployeeWithRole(fixture: Fixture, role: string, restaurantId = fixture.restaurantId, roleIds = fixture.roleIdByName) {
  const employee = await prisma.employee.create({
    data: { restaurantId, firstName: role, lastName: "Test" },
  });
  await prisma.employeeRole.create({ data: { employeeId: employee.id, roleId: roleIds[role] } });
  await prisma.employeeLocation.create({ data: { employeeId: employee.id, locationId: fixture.locationId } });
  return context(fixture, role, employee.id, restaurantId);
}

/** Registruje deljeni POS uređaj direktno (isti oblik kao registerDevice, bez potrebe da prolazi kroz ceo registerDevice tok za svaki test). */
async function createSharedDevice(fixture: Fixture, restaurantId = fixture.restaurantId, locationId = fixture.locationId) {
  return prisma.device.create({
    data: { restaurantId, locationId, name: "POS terminal — Main", deviceType: "POS" },
  });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("device management: RBAC", () => {
  it("OWNER can list and manage devices", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    const device = await createSharedDevice(fixture);

    await expect(devices.listDevices(owner)).resolves.toEqual(expect.any(Array));
    await expect(devices.renameDevice(owner, device.id, "Novi naziv")).resolves.toBeTruthy();
    await expect(devices.revokeDevice(owner, device.id)).resolves.toBeTruthy();
    await expect(devices.reactivateDevice(owner, device.id)).resolves.toBeTruthy();
  });

  it("ADMIN can manage devices", async () => {
    const fixture = await createFixture();
    const admin = await createEmployeeWithRole(fixture, "ADMIN");
    const device = await createSharedDevice(fixture);

    await expect(devices.revokeDevice(admin, device.id)).resolves.toBeTruthy();
  });

  it("MANAGER can manage devices (devices.manage is granted to MANAGER by design)", async () => {
    const fixture = await createFixture();
    const manager = await createEmployeeWithRole(fixture, "MANAGER");
    const device = await createSharedDevice(fixture);

    await expect(devices.revokeDevice(manager, device.id)).resolves.toBeTruthy();
  });

  it.each(["WAITER", "KITCHEN", "BAR"])("rejects %s from listing/managing devices", async (role) => {
    const fixture = await createFixture();
    const staff = await createEmployeeWithRole(fixture, role);
    const device = await createSharedDevice(fixture);

    await expect(devices.listDevices(staff)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(devices.renameDevice(staff, device.id, "x")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(devices.revokeDevice(staff, device.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(devices.reactivateDevice(staff, device.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("device management: cross-restaurant isolation", () => {
  it("listDevices never returns another restaurant's devices", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    await createSharedDevice(fixture);
    await createSharedDevice(fixture, fixture.otherRestaurantId, (await prisma.location.findFirstOrThrow({ where: { restaurantId: fixture.otherRestaurantId } })).id);

    const list = await devices.listDevices(owner);
    expect(list).toHaveLength(1);
    for (const d of list) {
      const row = await prisma.device.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.restaurantId).toBe(fixture.restaurantId);
    }
  });

  it("rejects renaming/revoking/reactivating a device belonging to another restaurant", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    const otherLocation = await prisma.location.findFirstOrThrow({ where: { restaurantId: fixture.otherRestaurantId } });
    const foreignDevice = await createSharedDevice(fixture, fixture.otherRestaurantId, otherLocation.id);

    await expect(devices.renameDevice(owner, foreignDevice.id, "Preuzeto")).rejects.toThrow("nije pronađen");
    await expect(devices.revokeDevice(owner, foreignDevice.id)).rejects.toThrow("nije pronađen");
    await expect(devices.reactivateDevice(owner, foreignDevice.id)).rejects.toThrow("nije pronađen");

    const unchanged = await prisma.device.findUniqueOrThrow({ where: { id: foreignDevice.id } });
    expect(unchanged.name).toBe("POS terminal — Main");
    expect(unchanged.isActive).toBe(true);
  });
});

describe("device management: revocation blocks authentication", () => {
  it("revoking blocks NEW PIN login attempts on that device", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    const device = await createSharedDevice(fixture);
    const waiter = await prisma.employee.create({
      data: { restaurantId: fixture.restaurantId, firstName: "Marko", lastName: "M", pinHash: await (await import("@rcs/auth")).hashPin("1234") },
    });
    await prisma.employeeRole.create({ data: { employeeId: waiter.id, roleId: fixture.roleIdByName.WAITER } });
    await prisma.employeeLocation.create({ data: { employeeId: waiter.id, locationId: fixture.locationId } });

    const request = () =>
      new Request("http://localhost/api/auth/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: waiter.id, deviceId: device.id, pin: "1234" }),
      });
    expect((await pinLogin(request())).status).toBe(200);

    await devices.revokeDevice(owner, device.id);
    expect((await pinLogin(request())).status).toBe(403);
  });

  it("revoking ALSO blocks the next request of an already-issued session on that device (the fixed gap)", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    const device = await createSharedDevice(fixture);
    const user = await prisma.user.create({ data: { username: `${randomUUID()}@test.local`, isActive: true } });
    const waiter = await prisma.employee.create({
      data: { restaurantId: fixture.restaurantId, userId: user.id, firstName: "Marko", lastName: "M" },
    });
    await prisma.employeeRole.create({ data: { employeeId: waiter.id, roleId: fixture.roleIdByName.WAITER } });
    await prisma.employeeLocation.create({ data: { employeeId: waiter.id, locationId: fixture.locationId } });

    const token = await createSessionToken({ userId: user.id, employeeId: waiter.id, restaurantId: fixture.restaurantId, deviceId: device.id });
    const request = () => new Request("http://localhost/protected", { headers: { cookie: `rcs_session=${token}` } });

    // Pre opoziva: ISTI token radi normalno
    await expect(requireAuth(request())).resolves.toBeTruthy();

    await devices.revokeDevice(owner, device.id);

    // Posle opoziva: ISTI, već izdat token sada odbačen na sledećem zahtevu
    await expect(requireAuth(request())).rejects.toThrow(UnauthorizedError);
  });

  it("reactivating restores normal validity for the SAME already-issued session token", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    const device = await createSharedDevice(fixture);
    const user = await prisma.user.create({ data: { username: `${randomUUID()}@test.local`, isActive: true } });
    const waiter = await prisma.employee.create({
      data: { restaurantId: fixture.restaurantId, userId: user.id, firstName: "Marko", lastName: "M" },
    });
    await prisma.employeeRole.create({ data: { employeeId: waiter.id, roleId: fixture.roleIdByName.WAITER } });
    await prisma.employeeLocation.create({ data: { employeeId: waiter.id, locationId: fixture.locationId } });

    const token = await createSessionToken({ userId: user.id, employeeId: waiter.id, restaurantId: fixture.restaurantId, deviceId: device.id });
    const request = () => new Request("http://localhost/protected", { headers: { cookie: `rcs_session=${token}` } });

    await devices.revokeDevice(owner, device.id);
    await expect(requireAuth(request())).rejects.toThrow(UnauthorizedError);

    await devices.reactivateDevice(owner, device.id);
    await expect(requireAuth(request())).resolves.toBeTruthy(); // ISTI token, bez ponovne prijave
  });

  it("sessions WITHOUT a deviceId are completely unaffected — no device lookup, no new failure mode", async () => {
    const fixture = await createFixture();
    const user = await prisma.user.create({ data: { username: `${randomUUID()}@test.local`, isActive: true } });
    const admin = await prisma.employee.create({
      data: { restaurantId: fixture.restaurantId, userId: user.id, firstName: "Ana", lastName: "Admin" },
    });
    await prisma.employeeRole.create({ data: { employeeId: admin.id, roleId: fixture.roleIdByName.ADMIN } });
    await prisma.employeeLocation.create({ data: { employeeId: admin.id, locationId: fixture.locationId } });

    // Namerno NEMA deviceId — isti oblik kao email/lozinka admin sesija.
    const token = await createSessionToken({ userId: user.id, employeeId: admin.id, restaurantId: fixture.restaurantId });
    const request = () => new Request("http://localhost/protected", { headers: { cookie: `rcs_session=${token}` } });

    const ctx = await requireAuth(request());
    expect(ctx.deviceId).toBeUndefined();
    expect(ctx.permissions.has("devices.manage")).toBe(true);
  });
});

describe("device management: rename preserves registration identity", () => {
  it("renaming changes ONLY the display name — id, registeredAt, isActive, employeeId untouched, and an active session on it keeps working", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    const device = await createSharedDevice(fixture);
    const before = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });

    const user = await prisma.user.create({ data: { username: `${randomUUID()}@test.local`, isActive: true } });
    const waiter = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, userId: user.id, firstName: "M", lastName: "M" } });
    await prisma.employeeRole.create({ data: { employeeId: waiter.id, roleId: fixture.roleIdByName.WAITER } });
    await prisma.employeeLocation.create({ data: { employeeId: waiter.id, locationId: fixture.locationId } });
    const token = await createSessionToken({ userId: user.id, employeeId: waiter.id, restaurantId: fixture.restaurantId, deviceId: device.id });
    const request = () => new Request("http://localhost/protected", { headers: { cookie: `rcs_session=${token}` } });

    await devices.renameDevice(owner, device.id, "Šank — pored ulaza");

    const after = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(after.id).toBe(before.id);
    expect(after.registeredAt.getTime()).toBe(before.registeredAt.getTime());
    expect(after.isActive).toBe(before.isActive);
    expect(after.employeeId).toBe(before.employeeId);
    expect(after.name).toBe("Šank — pored ulaza");

    await expect(requireAuth(request())).resolves.toBeTruthy(); // rename ne dira validnost sesije
  });
});

describe("device management: lastSeenAt (best-effort, throttled)", () => {
  it("updates lastSeenAt from null on the first authenticated request carrying that deviceId", async () => {
    const fixture = await createFixture();
    const device = await createSharedDevice(fixture);
    expect(device.lastSeenAt).toBeNull();

    const user = await prisma.user.create({ data: { username: `${randomUUID()}@test.local`, isActive: true } });
    const waiter = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, userId: user.id, firstName: "M", lastName: "M" } });
    await prisma.employeeRole.create({ data: { employeeId: waiter.id, roleId: fixture.roleIdByName.WAITER } });
    await prisma.employeeLocation.create({ data: { employeeId: waiter.id, locationId: fixture.locationId } });
    const token = await createSessionToken({ userId: user.id, employeeId: waiter.id, restaurantId: fixture.restaurantId, deviceId: device.id });
    const request = () => new Request("http://localhost/protected", { headers: { cookie: `rcs_session=${token}` } });

    const before = Date.now();
    await requireAuth(request());
    const updated = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(updated.lastSeenAt).not.toBeNull();
    expect(updated.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("throttles — a second request moments later does NOT re-write lastSeenAt", async () => {
    const fixture = await createFixture();
    const device = await createSharedDevice(fixture);
    const user = await prisma.user.create({ data: { username: `${randomUUID()}@test.local`, isActive: true } });
    const waiter = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, userId: user.id, firstName: "M", lastName: "M" } });
    await prisma.employeeRole.create({ data: { employeeId: waiter.id, roleId: fixture.roleIdByName.WAITER } });
    await prisma.employeeLocation.create({ data: { employeeId: waiter.id, locationId: fixture.locationId } });
    const token = await createSessionToken({ userId: user.id, employeeId: waiter.id, restaurantId: fixture.restaurantId, deviceId: device.id });
    const request = () => new Request("http://localhost/protected", { headers: { cookie: `rcs_session=${token}` } });

    await requireAuth(request());
    const first = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });

    await requireAuth(request());
    const second = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });

    expect(second.lastSeenAt!.getTime()).toBe(first.lastSeenAt!.getTime()); // NEMA drugog upisa u istom prozoru
  });

  it("a device with an already-recent lastSeenAt (manually seeded) is not rewritten by a subsequent request within the window", async () => {
    const fixture = await createFixture();
    const device = await createSharedDevice(fixture);
    const seeded = new Date(Date.now() - 60 * 1000); // 1 minute ago — well within the ~5 min throttle
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: seeded } });

    const user = await prisma.user.create({ data: { username: `${randomUUID()}@test.local`, isActive: true } });
    const waiter = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, userId: user.id, firstName: "M", lastName: "M" } });
    await prisma.employeeRole.create({ data: { employeeId: waiter.id, roleId: fixture.roleIdByName.WAITER } });
    await prisma.employeeLocation.create({ data: { employeeId: waiter.id, locationId: fixture.locationId } });
    const token = await createSessionToken({ userId: user.id, employeeId: waiter.id, restaurantId: fixture.restaurantId, deviceId: device.id });
    const request = () => new Request("http://localhost/protected", { headers: { cookie: `rcs_session=${token}` } });

    await requireAuth(request());
    const after = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(after.lastSeenAt!.getTime()).toBe(seeded.getTime());
  });
});

describe("device management: audit trail", () => {
  it("records device.renamed with previous/new name and the acting employee", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    const device = await createSharedDevice(fixture);

    await devices.renameDevice(owner, device.id, "Bar — levo krilo");

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Device", entityId: device.id, action: "device.renamed" } });
    expect((entry.previousValue as { name: string }).name).toBe("POS terminal — Main");
    expect((entry.newValue as { name: string }).name).toBe("Bar — levo krilo");
    expect(entry.userId).toBe(owner.userId);
  });

  it("records device.revoked and device.reactivated with previous/new isActive", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    const device = await createSharedDevice(fixture);

    await devices.revokeDevice(owner, device.id);
    const revoked = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Device", entityId: device.id, action: "device.revoked" } });
    expect((revoked.previousValue as { isActive: boolean }).isActive).toBe(true);
    expect((revoked.newValue as { isActive: boolean }).isActive).toBe(false);

    await devices.reactivateDevice(owner, device.id);
    const reactivated = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Device", entityId: device.id, action: "device.reactivated" } });
    expect((reactivated.previousValue as { isActive: boolean }).isActive).toBe(false);
    expect((reactivated.newValue as { isActive: boolean }).isActive).toBe(true);
  });

  it("revoking/reactivating an already-in-target-state device is a no-op — no duplicate audit entry", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    const device = await createSharedDevice(fixture);

    await devices.revokeDevice(owner, device.id);
    await devices.revokeDevice(owner, device.id); // already revoked — no-op

    const count = await prisma.auditLog.count({ where: { entityType: "Device", entityId: device.id, action: "device.revoked" } });
    expect(count).toBe(1);
  });

  it("listDevices resolves 'registered by' from the existing device.registered audit entry", async () => {
    const fixture = await createFixture();
    const owner = await createEmployeeWithRole(fixture, "OWNER");
    const location = await prisma.location.findFirstOrThrow({ where: { restaurantId: fixture.restaurantId } });

    const registered = await devices.registerDevice(owner, { locationId: location.id });
    const list = await devices.listDevices(owner);
    const row = list.find((d) => d.id === registered.id);
    expect(row).toBeTruthy();
    expect(row?.registeredBy).toBe("OWNER Test");
    expect(row?.isShared).toBe(true);
  });
});
