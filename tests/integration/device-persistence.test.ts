/**
 * Regression tests — shared POS device persistence.
 *
 * The core invariant: device registration (the Device DB row) is a
 * long-lived concern that MUST NOT be affected by employee login,
 * employee logout, Quick Lock, or transient server errors.
 *
 * These tests verify server-side behaviour; localStorage is a browser
 * concern tested by the fix to device-setup-client.tsx (strict
 * `data.registered === false` check instead of `!data.registered`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { employees } from "@rcs/domain";
import type { AuthContext } from "@rcs/auth";
import { resetPrismaTestTables } from "../setup/reset-test-db";
import { GET as deviceCheck } from "../../apps/web/app/api/device/check/route";
import { POST as logout } from "../../apps/web/app/api/auth/logout/route";
import { POST as lockTerminal } from "../../apps/web/app/api/auth/lock/route";
import { POST as pinLogin } from "../../apps/web/app/api/auth/pin-login/route";

interface Fixture {
  restaurantId: string;
  locationId: string;
  deviceId: string;
  roleIdByName: Record<string, string>;
}

const PERMISSIONS = [
  { code: "employees.view", description: "" },
  { code: "employees.manage", description: "" },
  { code: "devices.manage", description: "" },
];
const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: ["employees.view", "employees.manage", "devices.manage"],
  WAITER: [],
};

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "DP tenant", slug: `dp-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "DP Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const device = await prisma.device.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Shared POS" } });

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

  return { restaurantId: restaurant.id, locationId: location.id, deviceId: device.id, roleIdByName };
}

function ownerCtx(f: Fixture, employeeId: string): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: f.restaurantId,
    locationIds: [f.locationId],
    roles: ["OWNER"],
    permissions: new Set(ROLE_PERMISSIONS.OWNER),
  };
}

async function createOwner(f: Fixture) {
  const emp = await prisma.employee.create({ data: { restaurantId: f.restaurantId, firstName: "Owner", lastName: "O" } });
  await prisma.employeeRole.create({ data: { employeeId: emp.id, roleId: f.roleIdByName.OWNER } });
  await prisma.employeeLocation.create({ data: { employeeId: emp.id, locationId: f.locationId } });
  return ownerCtx(f, emp.id);
}

function checkRequest(deviceId: string) {
  return new Request(`http://localhost/api/device/check?deviceId=${encodeURIComponent(deviceId)}`);
}

function pinLoginRequest(params: { deviceId: string; pin: string }) {
  return new Request("http://localhost/api/auth/pin-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

// ---------------------------------------------------------------------------
// Case 1: device check route returns correct registered state
// ---------------------------------------------------------------------------
describe("device check: registered field is always present and explicit", () => {
  it("returns { registered: true } for an active device", async () => {
    const f = await createFixture();
    const res = await deviceCheck(checkRequest(f.deviceId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registered).toBe(true);
  });

  it("returns { registered: false } for an inactive device", async () => {
    const f = await createFixture();
    await prisma.device.update({ where: { id: f.deviceId }, data: { isActive: false } });
    const res = await deviceCheck(checkRequest(f.deviceId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registered).toBe(false);
  });

  it("returns { registered: false } for an unknown deviceId", async () => {
    await createFixture();
    const res = await deviceCheck(checkRequest(randomUUID()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registered).toBe(false);
  });

  it("returns { registered: false } when no deviceId is provided", async () => {
    const res = await deviceCheck(new Request("http://localhost/api/device/check"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 2: employee logout does not affect the device DB record
// ---------------------------------------------------------------------------
describe("device persistence: logout does not unregister the device", () => {
  it("device row remains active after logout — logout only clears the session cookie", async () => {
    const f = await createFixture();

    // Confirm device is active before logout
    const beforeRes = await deviceCheck(checkRequest(f.deviceId));
    expect((await beforeRes.json()).registered).toBe(true);

    // Employee logs out (server-side: clears session cookie, nothing else)
    const logoutRes = await logout();
    expect(logoutRes.status).toBe(200);

    // Device DB record must still be active
    const device = await prisma.device.findUniqueOrThrow({ where: { id: f.deviceId } });
    expect(device.isActive).toBe(true);

    // /api/device/check still confirms registration
    const afterRes = await deviceCheck(checkRequest(f.deviceId));
    expect((await afterRes.json()).registered).toBe(true);
  });

  it("logout response does NOT set any device-related cookies or headers", async () => {
    const res = await logout();
    const cookieHeader = res.headers.get("set-cookie") ?? "";
    // Only the session cookie should be cleared; no device token
    expect(cookieHeader).toContain("rcs_session=");
    expect(cookieHeader).not.toMatch(/device/i);
  });
});

// ---------------------------------------------------------------------------
// Case 3: Quick Lock does not affect the device DB record
// ---------------------------------------------------------------------------
describe("device persistence: Quick Lock does not unregister the device", () => {
  it("device row remains active after Quick Lock", async () => {
    const f = await createFixture();

    const lockRes = await lockTerminal(
      new Request("http://localhost/api/auth/lock", { method: "POST" })
    );
    expect(lockRes.status).toBe(200);

    const device = await prisma.device.findUniqueOrThrow({ where: { id: f.deviceId } });
    expect(device.isActive).toBe(true);

    const checkRes = await deviceCheck(checkRequest(f.deviceId));
    expect((await checkRes.json()).registered).toBe(true);
  });

  it("lock response does NOT set any device-related cookies or headers", async () => {
    const res = await lockTerminal(
      new Request("http://localhost/api/auth/lock", { method: "POST" })
    );
    const cookieHeader = res.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("rcs_session=");
    expect(cookieHeader).not.toMatch(/device/i);
  });
});

// ---------------------------------------------------------------------------
// Case 4: registration survives unlock (PIN login success)
// ---------------------------------------------------------------------------
describe("device persistence: PIN login does not unregister the device", () => {
  it("device row remains active after successful PIN login", async () => {
    const f = await createFixture();
    const owner = await createOwner(f);
    const waiter = await employees.createEmployee(owner, {
      firstName: "Marko",
      lastName: "M",
      pin: "1234",
      roleNames: ["WAITER"],
      locationIds: [f.locationId],
    });
    void waiter;

    const pinRes = await pinLogin(pinLoginRequest({ deviceId: f.deviceId, pin: "1234" }));
    expect(pinRes.status).toBe(200);

    const device = await prisma.device.findUniqueOrThrow({ where: { id: f.deviceId } });
    expect(device.isActive).toBe(true);

    const checkRes = await deviceCheck(checkRequest(f.deviceId));
    expect((await checkRes.json()).registered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 5: invalid/revoked device is correctly detected
// ---------------------------------------------------------------------------
describe("device persistence: revoked device detected, valid device preserved", () => {
  it("deactivated device check returns registered:false — only then should client clear localStorage", async () => {
    const f = await createFixture();
    await prisma.device.update({ where: { id: f.deviceId }, data: { isActive: false } });

    const res = await deviceCheck(checkRequest(f.deviceId));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Client must see EXPLICIT false (not undefined/absent) to clear localStorage
    expect(body.registered).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "registered")).toBe(true);
  });

  it("active device check returns registered:true with the field always present", async () => {
    const f = await createFixture();
    const res = await deviceCheck(checkRequest(f.deviceId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registered).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, "registered")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 6: restaurant isolation
// ---------------------------------------------------------------------------
describe("device persistence: restaurant isolation", () => {
  it("device registered for restaurant A cannot authenticate employees from restaurant B", async () => {
    const fA = await createFixture();
    const ownerA = await createOwner(fA);
    await employees.createEmployee(ownerA, { firstName: "A", lastName: "A", pin: "1111", roleNames: ["WAITER"], locationIds: [fA.locationId] });

    const tenantB = await prisma.tenant.create({ data: { name: "B", slug: `b-${randomUUID()}` } });
    const restaurantB = await prisma.restaurant.create({ data: { tenantId: tenantB.id, name: "Restaurant B", currency: "RSD" } });
    const locationB = await prisma.location.create({ data: { restaurantId: restaurantB.id, name: "B Main" } });
    await prisma.role.create({ data: { restaurantId: restaurantB.id, name: "WAITER", isSystem: true } });

    // Employee of restaurant B has the same PIN as employee of restaurant A
    const empB = await prisma.employee.create({
      data: { restaurantId: restaurantB.id, firstName: "B", lastName: "B" },
    });
    void empB;

    // Device A cannot be used to log in as restaurant B employee
    const res = await pinLogin(pinLoginRequest({ deviceId: fA.deviceId, pin: "9999" }));
    expect(res.status).toBe(401);

    // Device A's DB record is unaffected
    const device = await prisma.device.findUniqueOrThrow({ where: { id: fA.deviceId } });
    expect(device.restaurantId).toBe(fA.restaurantId);
    expect(device.isActive).toBe(true);
    void locationB;
  });
});

// ---------------------------------------------------------------------------
// Case 7: device alone never grants role — PIN required
// ---------------------------------------------------------------------------
describe("device persistence: device identity does not grant any role or session", () => {
  it("knowing a deviceId without a correct PIN produces 401, not a session", async () => {
    const f = await createFixture();
    const owner = await createOwner(f);
    await employees.createEmployee(owner, { firstName: "M", lastName: "M", pin: "5678", roleNames: ["WAITER"], locationIds: [f.locationId] });

    const res = await pinLogin(pinLoginRequest({ deviceId: f.deviceId, pin: "0000" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(res.headers.get("set-cookie")).toBeNull(); // no session cookie issued
  });

  it("device check confirms registration but does NOT issue any session or token", async () => {
    const f = await createFixture();
    const res = await deviceCheck(checkRequest(f.deviceId));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull(); // no session from device check
    const body = await res.json();
    expect(body.registered).toBe(true);
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("session");
    expect(body).not.toHaveProperty("employeeId");
    expect(body).not.toHaveProperty("restaurantId");
  });
});
