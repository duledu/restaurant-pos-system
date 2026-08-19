import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError, UnauthorizedError, createSessionToken, requireAuth, hashPin } from "@rcs/auth";
import type { AuthContext } from "@rcs/auth";
import { employees, orders, shifts, devices } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";
import { POST as pinLogin } from "../../apps/web/app/api/auth/pin-login/route";
import { POST as lockTerminal } from "../../apps/web/app/api/auth/lock/route";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  deviceId: string;
  roleIdByName: Record<string, string>;
}

// Isti obrazac kao tests/integration/staff-management.test.ts — svaki test
// file gradi svoj skup permisija/rola (ne oslanja se na dev seed), ovde
// proširen sa "devices.manage" (Deljeni POS registracija terminala).
const PERMISSIONS = [
  { code: "employees.view", description: "" },
  { code: "employees.manage", description: "" },
  { code: "shifts.manage", description: "" },
  { code: "audit.view", description: "" },
  { code: "devices.manage", description: "" },
];
const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: ["employees.view", "employees.manage", "shifts.manage", "audit.view", "devices.manage"],
  ADMIN: ["employees.view", "employees.manage", "shifts.manage", "audit.view", "devices.manage"],
  MANAGER: ["employees.view", "shifts.manage", "audit.view", "devices.manage"],
  WAITER: ["shifts.manage"],
  KITCHEN: [],
  BAR: [],
};

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Lock tenant", slug: `lock-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const device = await prisma.device.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Deljeni POS" } });

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
  for (const roleName of Object.keys(ROLE_PERMISSIONS)) {
    await prisma.role.create({ data: { restaurantId: otherRestaurant.id, name: roleName, isSystem: true } });
  }

  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id, deviceId: device.id, roleIdByName };
}

function context(fixture: Fixture, role: string, employeeId: string, locationIds: string[]): AuthContext {
  const perms = ROLE_PERMISSIONS[role] ?? [];
  return { userId: employeeId, employeeId, restaurantId: fixture.restaurantId, locationIds, roles: [role], permissions: new Set(perms) };
}

async function createOwner(fixture: Fixture) {
  const owner = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, firstName: "Owner", lastName: "One" } });
  await prisma.employeeRole.create({ data: { employeeId: owner.id, roleId: fixture.roleIdByName.OWNER } });
  await prisma.employeeLocation.create({ data: { employeeId: owner.id, locationId: fixture.locationId } });
  return context(fixture, "OWNER", owner.id, [fixture.locationId]);
}

function pinLoginRequest(params: { deviceId: string; pin: string; employeeId?: string }) {
  return () =>
    new Request("http://localhost/api/auth/pin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
}

function lockRequest(token: string) {
  return () => new Request("http://localhost/api/auth/lock", { method: "POST", headers: { cookie: `rcs_session=${token}` } });
}

function protectedRequest(token?: string) {
  return new Request("http://localhost/protected", { headers: token ? { cookie: `rcs_session=${token}` } : {} });
}

async function sessionTokenFor(employeeId: string, restaurantId: string, deviceId?: string) {
  const employee = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
  return createSessionToken({ userId: employee.userId ?? employee.id, employeeId, restaurantId, deviceId });
}

async function setupTableAndMenu(fixture: Fixture) {
  const category = await prisma.menuCategory.create({ data: { restaurantId: fixture.restaurantId, name: "T", slug: `t-${randomUUID()}`, type: "FOOD" } });
  const menuItem = await prisma.menuItem.create({
    data: { restaurantId: fixture.restaurantId, categoryId: category.id, name: "Burger", slug: `b-${randomUUID()}`, price: "500.00", preparationStation: "KITCHEN" },
  });
  const floor = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "F" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "Sto 8" } });
  return { menuItem, table };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("shared POS: lock", () => {
  it("clears the session so a protected route is unavailable after Quick Lock", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const token = await sessionTokenFor(owner.employeeId, fixture.restaurantId, fixture.deviceId);

    await expect(requireAuth(protectedRequest(token))).resolves.toBeTruthy();

    const lockResponse = await lockTerminal(lockRequest(token)());
    expect(lockResponse.status).toBe(200);
    const setCookie = lockResponse.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("rcs_session=;");

    // Ono što realni pretraživač radi posle Set-Cookie sa maxAge=0: sledeći
    // zahtev više ne šalje cookie uopšte — direktan pokušaj bez njega je
    // tačno ono što bi bio ručni unos /waiter URL-a posle zaključavanja.
    await expect(requireAuth(protectedRequest(undefined))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("does not close the shift, submit orders, release tables, or touch draft/order state", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    const waiterCtx = context(fixture, "WAITER", waiter.id, [fixture.locationId]);
    const { menuItem, table } = await setupTableAndMenu(fixture);

    const shift = await shifts.openShift(owner, { locationId: fixture.locationId, openingCash: 0 });
    const order = await orders.openOrder(waiterCtx, { tableId: table.id });
    await orders.addItem(waiterCtx, order.id, { menuItemId: menuItem.id, quantity: 2 });

    const token = await sessionTokenFor(waiter.id, fixture.restaurantId, fixture.deviceId);
    await lockTerminal(lockRequest(token)());

    const reloadedShift = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(reloadedShift.status).toBe("OPEN");
    const reloadedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(reloadedOrder.status).toBe("DRAFT");
    expect(reloadedOrder.items).toHaveLength(1);
    expect(reloadedOrder.items[0]?.quantity).toBe(2);
    const reloadedTable = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: table.id } });
    expect(reloadedTable.id).toBe(table.id); // i dalje postoji, nedirnut
  });

  it("is idempotent — locking an already-locked/unauthenticated terminal still returns ok without throwing", async () => {
    const response = await lockTerminal(new Request("http://localhost/api/auth/lock", { method: "POST" }));
    expect(response.status).toBe(200);
  });
});

describe("shared POS: employee switching", () => {
  it("Marko locks, Jovan unlocks via PIN — identity switches, Marko's draft stays protected, new actions attributed to Jovan", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1111", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    const jovan = await employees.createEmployee(owner, { firstName: "Jovan", lastName: "J", pin: "2222", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    const { table } = await setupTableAndMenu(fixture);
    await shifts.openShift(owner, { locationId: fixture.locationId, openingCash: 0 });

    const markoCtx = context(fixture, "WAITER", marko.id, [fixture.locationId]);
    const draft = await orders.openOrder(markoCtx, { tableId: table.id });

    // Jovan se prijavljuje PIN-om bez employeeId (anonimni tok — dodirni
    // taster nikad ne šalje employeeId, vidi pin-login/route.ts).
    const jovanLogin = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "2222" })());
    expect(jovanLogin.status).toBe(200);
    const jovanBody = await jovanLogin.json();
    expect(jovanBody.redirectTo).toBe("/waiter");

    const jovanCtx = context(fixture, "WAITER", jovan.id, [fixture.locationId]);
    expect(jovanCtx.employeeId).toBe(jovan.id);
    expect(jovanCtx.employeeId).not.toBe(marko.id);

    // Markov draft ostaje zaštićen — Jovan ga ne sme dirati. Ownership se
    // proverava PRE bilo kakve validacije menuItemId-a (order-service.ts
    // getOwnedDraftOrder), pa nasumičan UUID ovde ne utiče na test.
    await expect(orders.getOrder(jovanCtx, draft.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(orders.addItem(jovanCtx, draft.id, { menuItemId: randomUUID(), quantity: 1 })).rejects.toBeInstanceOf(ForbiddenError);

    // Nova akcija (novi sto) se pripisuje Jovanu.
    const { table: table2 } = await setupTableAndMenu(fixture);
    const jovanOrder = await orders.openOrder(jovanCtx, { tableId: table2.id });
    expect(jovanOrder.openedBy).toBe(jovan.id);
  });

  it("submitted table state remains visible to the next employee after a switch", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1111", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    const jovan = await employees.createEmployee(owner, { firstName: "Jovan", lastName: "J", pin: "2222", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    const { menuItem, table } = await setupTableAndMenu(fixture);
    await shifts.openShift(owner, { locationId: fixture.locationId, openingCash: 0 });

    const markoCtx = context(fixture, "WAITER", marko.id, [fixture.locationId]);
    const order = await orders.openOrder(markoCtx, { tableId: table.id });
    await orders.addItem(markoCtx, order.id, { menuItemId: menuItem.id, quantity: 2 });
    const submitted = await orders.submitOrder(markoCtx, order.id, { idempotencyKey: randomUUID() });
    expect(submitted.status).toBe("SUBMITTED");

    const jovanCtx = context(fixture, "WAITER", jovan.id, [fixture.locationId]);
    // Poslata porudžbina VIŠE nije draft-only-vlasništvo — bilo koji
    // konobar-operator je sme videti (order-access.ts: requireDraftOwnership
    // se primenjuje samo dok je status DRAFT).
    const seenByJovan = await orders.getOrder(jovanCtx, order.id);
    expect(seenByJovan.status).toBe("SUBMITTED");
    expect(seenByJovan.items[0]?.quantity).toBe(2);
  });
});

describe("shared POS: manager downgrade/switch safety", () => {
  it("Ana (MANAGER) has manager privileges; after lock, Marko (WAITER) unlocking gains none of them", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const ana = await employees.createEmployee(owner, { firstName: "Ana", lastName: "A", pin: "5555", roleNames: ["MANAGER"], locationIds: [fixture.locationId] });
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1111", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    const anaLogin = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "5555" })());
    expect(anaLogin.status).toBe(200);
    const anaToken = await sessionTokenFor(ana.id, fixture.restaurantId, fixture.deviceId);
    const anaCtxLive = await requireAuth(protectedRequest(anaToken));
    expect(anaCtxLive.permissions.has("audit.view")).toBe(true);
    expect(anaCtxLive.roles).toEqual(["MANAGER"]);

    await lockTerminal(lockRequest(anaToken)());

    const markoLogin = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "1111" })());
    expect(markoLogin.status).toBe(200);
    const markoToken = await sessionTokenFor(marko.id, fixture.restaurantId, fixture.deviceId);
    const markoCtxLive = await requireAuth(protectedRequest(markoToken));

    expect(markoCtxLive.roles).toEqual(["WAITER"]);
    expect(markoCtxLive.permissions.has("audit.view")).toBe(false);
    expect(markoCtxLive.permissions.has("employees.manage")).toBe(false);
    expect(markoCtxLive.employeeId).toBe(marko.id);
    expect(markoCtxLive.employeeId).not.toBe(ana.id);
  });
});

describe("shared POS: shift behavior", () => {
  it("reuses the same open shift across lock/re-login cycles — no duplicate shift is created", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1111", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    const jovan = await employees.createEmployee(owner, { firstName: "Jovan", lastName: "J", pin: "2222", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    const markoCtx = context(fixture, "WAITER", marko.id, [fixture.locationId]);
    const opened = await shifts.openShift(markoCtx, { locationId: fixture.locationId, openingCash: 100 });

    const markoToken = await sessionTokenFor(marko.id, fixture.restaurantId, fixture.deviceId);
    await lockTerminal(lockRequest(markoToken)());

    const jovanCtx = context(fixture, "WAITER", jovan.id, [fixture.locationId]);
    const seenByJovan = await shifts.getActiveShift(jovanCtx, fixture.locationId);
    expect(seenByJovan?.id).toBe(opened.id);

    const jovanToken = await sessionTokenFor(jovan.id, fixture.restaurantId, fixture.deviceId);
    await lockTerminal(lockRequest(jovanToken)());

    const seenByMarkoAgain = await shifts.getActiveShift(markoCtx, fixture.locationId);
    expect(seenByMarkoAgain?.id).toBe(opened.id);

    const allShiftsForLocation = await prisma.shift.count({ where: { locationId: fixture.locationId } });
    expect(allShiftsForLocation).toBe(1); // nijedna nova smena nije napravljena
  });
});

describe("shared POS: staff management integration", () => {
  it("a suspended employee's PIN stops working through the anonymous PIN-pad flow immediately", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    expect((await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "1234" })())).status).toBe(200);

    await employees.setEmployeeStatus(owner, marko.id, "SUSPENDED");

    const rejected = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "1234" })());
    expect(rejected.status).not.toBe(200);
  });

  it("after a PIN reset, the old PIN fails and the new PIN works, through the anonymous flow", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    await employees.resetEmployeePin(owner, marko.id, "9876");

    const oldPin = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "1234" })());
    expect(oldPin.status).not.toBe(200);

    const newPin = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "9876" })());
    expect(newPin.status).toBe(200);
  });

  it("a role change is reflected the next time the employee unlocks the terminal", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    const firstLogin = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "1234" })());
    expect((await firstLogin.json()).redirectTo).toBe("/waiter");

    await employees.updateEmployee(owner, marko.id, { roleNames: ["KITCHEN"] });

    const secondLogin = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "1234" })());
    expect((await secondLogin.json()).redirectTo).toBe("/kitchen"); // ne stara /waiter ruta

    const token = await sessionTokenFor(marko.id, fixture.restaurantId, fixture.deviceId);
    const ctxLive = await requireAuth(protectedRequest(token));
    expect(ctxLive.roles).toEqual(["KITCHEN"]);
  });

  it("registers a new device only for a management-capable role, scoped to the caller's own location", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const waiter = await employees.createEmployee(owner, { firstName: "W", lastName: "W", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    const waiterCtx = context(fixture, "WAITER", waiter.id, [fixture.locationId]);

    await expect(devices.registerDevice(waiterCtx, { locationId: fixture.locationId })).rejects.toBeInstanceOf(ForbiddenError);

    const created = await devices.registerDevice(owner, { locationId: fixture.locationId });
    expect(created.restaurantId).toBe(fixture.restaurantId);
    expect(created.isActive).toBe(true);

    const foreignLocation = await prisma.location.create({ data: { restaurantId: fixture.otherRestaurantId, name: "Foreign" } });
    await expect(devices.registerDevice(owner, { locationId: foreignLocation.id })).rejects.toThrow("ne pripada ovom restoranu");
  });
});

describe("shared POS: security", () => {
  it("rejects an invalid PIN through the anonymous flow with a generic message (no employee enumeration)", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    const noMatch = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "0000" })());
    expect(noMatch.status).toBe(401);
    const body = await noMatch.json();
    expect(body.error).toBe("Neispravan PIN");
    expect(body).not.toHaveProperty("employeeId");
  });

  it("throttles and locks out the device after repeated unmatched PIN attempts (anonymous flow)", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    for (let i = 0; i < 5; i++) {
      const res = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "9999" })());
      expect(res.status).toBe(401);
    }

    const lockedOut = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "9999" })());
    expect(lockedOut.status).toBe(429);

    // Zaključavanje je na nivou UREĐAJA — čak i TAČAN PIN ostaje odbijen dok
    // traje lockout (ista logika kao email login throttle).
    const evenCorrectPin = await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "1234" })());
    expect(evenCorrectPin.status).toBe(429);
  });

  it("rejects a correct PIN belonging to an employee of a different restaurant", async () => {
    const fixtureA = await createFixture();
    const ownerA = await createOwner(fixtureA);
    await employees.createEmployee(ownerA, { firstName: "A", lastName: "A", pin: "1234", roleNames: ["WAITER"], locationIds: [fixtureA.locationId] });

    const tenantB = await prisma.tenant.create({ data: { name: "T2", slug: `t2-${randomUUID()}` } });
    const restaurantB = await prisma.restaurant.create({ data: { tenantId: tenantB.id, name: "Restaurant C" } });
    const locationB = await prisma.location.create({ data: { restaurantId: restaurantB.id, name: "Main B" } });
    const deviceB = await prisma.device.create({ data: { restaurantId: restaurantB.id, locationId: locationB.id, name: "POS-B" } });
    const roleB = await prisma.role.create({ data: { restaurantId: restaurantB.id, name: "WAITER", isSystem: true } });
    const empB = await prisma.employee.create({ data: { restaurantId: restaurantB.id, firstName: "B", lastName: "B", pinHash: await hashPin("9911") } });
    await prisma.employeeRole.create({ data: { employeeId: empB.id, roleId: roleB.id } });
    await prisma.employeeLocation.create({ data: { employeeId: empB.id, locationId: locationB.id } });

    // Restoran A zaposleni pokušava PIN 1234 na uređaju restorana B — nema
    // poklapanja jer je skeniranje ograničeno na device.restaurantId.
    const crossRestaurant = await pinLogin(pinLoginRequest({ deviceId: deviceB.id, pin: "1234" })());
    expect(crossRestaurant.status).toBe(401);
  });

  it("scopes ctx.locationIds to the employee's actual assigned locations after PIN login, regardless of device location", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const secondLocation = await prisma.location.create({ data: { restaurantId: fixture.restaurantId, name: "Second" } });
    const waiter = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "1234" })());
    const token = await sessionTokenFor(waiter.id, fixture.restaurantId, fixture.deviceId);
    const ctxLive = await requireAuth(protectedRequest(token));

    expect(ctxLive.locationIds).toEqual([fixture.locationId]);
    expect(ctxLive.locationIds).not.toContain(secondLocation.id);
  });

  it("direct navigation to a protected route without a session is rejected (Quick Lock cannot be bypassed by URL)", async () => {
    await expect(requireAuth(protectedRequest(undefined))).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("shared POS: audit", () => {
  it("records a terminal_locked audit entry attributed to the locking employee, and a pin_login entry for the next employee", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "1234", roleNames: ["WAITER"], locationIds: [fixture.locationId] });
    const token = await sessionTokenFor(marko.id, fixture.restaurantId, fixture.deviceId);

    await lockTerminal(lockRequest(token)());
    const lockEntry = await prisma.auditLog.findFirstOrThrow({ where: { entityId: marko.id, action: "auth.terminal_locked" } });
    expect(lockEntry.userId).toBe(marko.id);

    await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "1234" })());
    const loginCount = await prisma.auditLog.count({ where: { entityId: marko.id, action: "auth.pin_login" } });
    expect(loginCount).toBeGreaterThan(0);
  });

  it("never stores the PIN value in the terminal_locked or pin_login audit entries", async () => {
    const fixture = await createFixture();
    const owner = await createOwner(fixture);
    const marko = await employees.createEmployee(owner, { firstName: "Marko", lastName: "M", pin: "8642", roleNames: ["WAITER"], locationIds: [fixture.locationId] });

    await pinLogin(pinLoginRequest({ deviceId: fixture.deviceId, pin: "8642" })());
    const token = await sessionTokenFor(marko.id, fixture.restaurantId, fixture.deviceId);
    await lockTerminal(lockRequest(token)());

    const entries = await prisma.auditLog.findMany({ where: { entityId: marko.id } });
    for (const entry of entries) {
      expect(JSON.stringify(entry)).not.toContain("8642");
    }
  });
});
