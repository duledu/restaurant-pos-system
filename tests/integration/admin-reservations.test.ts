import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { createSessionToken } from "@rcs/auth";
import { GET as list, POST as create } from "../../apps/web/app/api/pos/reservations/route";
import { GET as detail, PATCH as edit } from "../../apps/web/app/api/pos/reservations/[id]/route";
import { POST as cancel } from "../../apps/web/app/api/pos/reservations/[id]/cancel/route";
import { POST as noShow } from "../../apps/web/app/api/pos/reservations/[id]/no-show/route";
import { resetPrismaTestTables } from "../setup/reset-test-db";

const date = "2099-06-15";
const input = { guestName: "Shared Guest", phone: "060123456", partySize: 4, date, time: "19:00", note: "Window seat" };
async function fixture() {
  const tenant = await prisma.tenant.create({ data: { name: "Reservations integration", slug: randomUUID() } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", timezone: "Europe/Belgrade" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Main" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "7", capacity: 4 } });
  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id };
}
async function session(f: Awaited<ReturnType<typeof fixture>>, name: string, permissions = ["reservations.view", "reservations.manage"]) {
  const role = await prisma.role.create({ data: { restaurantId: f.restaurantId, name, isSystem: true } });
  for (const code of permissions) {
    const permission = await prisma.permission.upsert({ where: { code }, create: { code, description: code }, update: {} });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }
  const user = await prisma.user.create({ data: { username: randomUUID(), isActive: true } });
  const employee = await prisma.employee.create({ data: { restaurantId: f.restaurantId, userId: user.id, firstName: name, lastName: "Test" } });
  await prisma.employeeRole.create({ data: { employeeId: employee.id, roleId: role.id } });
  await prisma.employeeLocation.create({ data: { employeeId: employee.id, locationId: f.locationId } });
  return createSessionToken({ userId: user.id, employeeId: employee.id, restaurantId: f.restaurantId });
}
type Handler = (request: Request, context: { params: { id: string } }) => Promise<Response>;
function call(handler: Handler, token: string, path: string, method = "GET", body?: unknown) {
  return handler(new Request(`http://localhost/api/pos/reservations${path}`, {
    method, headers: { cookie: `rcs_session=${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { params: { id: path.split("/")[1] ?? "" } });
}
async function book(f: Awaited<ReturnType<typeof fixture>>, token: string, overrides = {}) {
  const result = await call(create, token, "", "POST", { ...input, locationId: f.locationId, tableId: f.tableId, ...overrides });
  expect(result.status).toBe(201);
  return (await result.json()).reservation;
}
beforeEach(async () => { await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles"); });

describe("Shared Admin/Manager/Waiter reservation API with real sessions", () => {
  it.each([["ADMIN", "WAITER"], ["WAITER", "ADMIN"]])("%s creates and %s reads the identical record", async (writer, reader) => {
    const f = await fixture(), writeToken = await session(f, writer), readToken = await session(f, reader);
    const created = await book(f, writeToken);
    const result = await call(list, readToken, `?locationId=${f.locationId}&date=${date}`);
    expect(result.status).toBe(200);
    expect((await result.json()).reservations).toEqual([expect.objectContaining({ id: created.id, guestName: input.guestName, tableId: f.tableId })]);
    expect(await prisma.reservation.count()).toBe(1);
  });

  it("Manager edits and Waiter reads the new date, time and guest details", async () => {
    const f = await fixture(), manager = await session(f, "MANAGER"), waiter = await session(f, "WAITER");
    const row = await book(f, waiter);
    expect((await call(edit, manager, `/${row.id}`, "PATCH", { ...input, date: "2099-06-16", time: "20:30", partySize: 5, tableId: f.tableId })).status).toBe(200);
    const updated = await call(detail, waiter, `/${row.id}`);
    expect((await updated.json()).reservation).toMatchObject({ id: row.id, reservedAt: "2099-06-16T18:30:00.000Z", partySize: 5 });
    expect((await (await call(list, waiter, `?locationId=${f.locationId}&date=${date}`)).json()).reservations).toHaveLength(0);
  });

  it("Waiter changes status and Admin sees NO_SHOW; Admin cancellation is visible to Waiter", async () => {
    const f = await fixture(), admin = await session(f, "ADMIN"), waiter = await session(f, "WAITER");
    const first = await book(f, admin);
    expect((await call(noShow, waiter, `/${first.id}/no-show`, "POST")).status).toBe(200);
    expect((await (await call(detail, admin, `/${first.id}`)).json()).reservation.status).toBe("NO_SHOW");
    const second = await book(f, waiter);
    expect((await call(cancel, admin, `/${second.id}/cancel`, "POST", {})).status).toBe(200);
    expect((await (await call(detail, waiter, `/${second.id}`)).json()).reservation.status).toBe("CANCELLED");
    expect((await prisma.restaurantTable.findUniqueOrThrow({ where: { id: f.tableId } })).status).toBe("FREE");
    expect(await prisma.order.count()).toBe(0);
  });

  it("rejects conflicts between Admin and Waiter on both create and edit", async () => {
    const f = await fixture(), admin = await session(f, "ADMIN"), waiter = await session(f, "WAITER");
    await book(f, waiter);
    const conflicting = { ...input, locationId: f.locationId, tableId: f.tableId, time: "19:30" };
    expect((await call(create, admin, "", "POST", conflicting)).status).toBe(409);
    const other = await book(f, admin, { time: "22:00" });
    expect((await call(edit, admin, `/${other.id}`, "PATCH", conflicting)).status).toBe(409);
    expect(await prisma.reservation.count()).toBe(2);
  });

  it.each(["KITCHEN", "BAR", "INVENTORY_MANAGER"])("denies %s without reservation permissions", async role => {
    const f = await fixture(), token = await session(f, role, []);
    expect((await call(create, token, "", "POST", { ...input, locationId: f.locationId })).status).toBe(403);
    expect((await call(list, token, `?locationId=${f.locationId}&date=${date}`)).status).toBe(403);
  });

  it("view permission permits reads but denies create, edit and cancellation; no session receives 401", async () => {
    const f = await fixture(), admin = await session(f, "ADMIN"), reader = await session(f, "MANAGER", ["reservations.view"]);
    const row = await book(f, admin);
    expect((await call(detail, reader, `/${row.id}`)).status).toBe(200);
    expect((await call(create, reader, "", "POST", { ...input, locationId: f.locationId })).status).toBe(403);
    expect((await call(edit, reader, `/${row.id}`, "PATCH", input)).status).toBe(403);
    expect((await call(cancel, reader, `/${row.id}/cancel`, "POST", {})).status).toBe(403);
    expect((await call(list, "", `?locationId=${f.locationId}&date=${date}`)).status).toBe(401);
  });

  it("blocks another restaurant's records and locations even for Admin", async () => {
    const a = await fixture(), b = await fixture(), admin = await session(a, "ADMIN"), other = await session(b, "ADMIN");
    const row = await book(b, other);
    expect((await (await call(list, admin, `?locationId=${a.locationId}&date=${date}`)).json()).reservations).toEqual([]);
    expect((await call(list, admin, `?locationId=${b.locationId}&date=${date}`)).status).toBe(403);
    expect((await call(create, admin, "", "POST", { ...input, locationId: b.locationId })).status).toBe(403);
    for (const [handler, method, suffix, body] of [[detail, "GET", "", undefined], [edit, "PATCH", "", input], [cancel, "POST", "/cancel", {}]] as const) {
      expect((await call(handler, admin, `/${row.id}${suffix}`, method, body)).status).toBe(400);
    }
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("CONFIRMED");
  });

  it("blocks an unassigned location in the same restaurant", async () => {
    const f = await fixture(), manager = await session(f, "MANAGER");
    const other = await prisma.location.create({ data: { restaurantId: f.restaurantId, name: "Restricted" } });
    expect((await call(list, manager, `?locationId=${other.id}&date=${date}`)).status).toBe(403);
    expect((await call(create, manager, "", "POST", { ...input, locationId: other.id })).status).toBe(403);
  });
});
