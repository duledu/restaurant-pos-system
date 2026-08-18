/**
 * Dokazuje zahtev iz docs/database-safety.md #4/#6: normalne administrativne
 * radnje (deaktivacija zaposlenog, arhiviranje/brisanje artikla menija,
 * uklanjanje uređaja) NE SMEJU obrisati ili "prepisati" istorijske
 * finansijske podatke (Payment/Receipt/Order/OrderItem), a izveštaji MORAJU
 * i dalje prikazivati tu istoriju posle takvih izmena.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, employees, menu, reporting } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  menuItemId: string;
  roleIdByName: Record<string, string>;
}

const PERMISSIONS = [
  { code: "employees.manage", description: "" },
  { code: "menu.manage", description: "" },
  { code: "audit.view", description: "" },
];
const OWNER_PERMS = PERMISSIONS.map((p) => p.code);

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Retention tenant", slug: `retention-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const menuItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Burger",
      slug: `burger-${randomUUID()}`,
      price: "100.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });

  const permissions = await Promise.all(
    PERMISSIONS.map((p) => prisma.permission.upsert({ where: { code: p.code }, create: p, update: {} }))
  );
  const permissionByCode = Object.fromEntries(permissions.map((p) => [p.code, p]));
  const roleIdByName: Record<string, string> = {};
  for (const roleName of ["OWNER", "WAITER"]) {
    const role = await prisma.role.create({ data: { restaurantId: restaurant.id, name: roleName, isSystem: true } });
    roleIdByName[roleName] = role.id;
  }
  await prisma.rolePermission.createMany({
    data: OWNER_PERMS.map((code) => ({ roleId: roleIdByName.OWNER, permissionId: permissionByCode[code].id })),
  });

  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, menuItemId: menuItem.id, roleIdByName };
}

async function createOwnerCtx(fixture: Fixture): Promise<AuthContext> {
  const owner = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, firstName: "Owner", lastName: "One" } });
  await prisma.employeeRole.create({ data: { employeeId: owner.id, roleId: fixture.roleIdByName.OWNER } });
  await prisma.employeeLocation.create({ data: { employeeId: owner.id, locationId: fixture.locationId } });
  return {
    userId: owner.id,
    employeeId: owner.id,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["OWNER"],
    permissions: new Set(OWNER_PERMS),
  };
}

async function createWaiterEmployee(fixture: Fixture) {
  const waiter = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, firstName: "Konobar", lastName: "Jedan" } });
  await prisma.employeeRole.create({ data: { employeeId: waiter.id, roleId: fixture.roleIdByName.WAITER } });
  await prisma.employeeLocation.create({ data: { employeeId: waiter.id, locationId: fixture.locationId } });
  const ctx: AuthContext = {
    userId: waiter.id,
    employeeId: waiter.id,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: ["WAITER"],
    permissions: new Set<string>(),
  };
  return { waiter, ctx };
}

async function sellOneItem(fixture: Fixture, waiterCtx: AuthContext) {
  const order = await orders.openOrder(waiterCtx, { tableId: fixture.tableId });
  await orders.addItem(waiterCtx, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
  const submitted = await orders.submitOrder(waiterCtx, order.id, { idempotencyKey: randomUUID() });
  return billing.completePayment(waiterCtx, submitted.id, { method: "CASH", tenderedAmount: 200 });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

afterAll(async () => prisma.$disconnect());

describe("data retention: employee deactivation", () => {
  it("does not delete a suspended employee's historical orders/payments, and reports still show them", async () => {
    const fixture = await createFixture();
    const ownerCtx = await createOwnerCtx(fixture);
    const { waiter, ctx: waiterCtx } = await createWaiterEmployee(fixture);

    const { order, payment } = await sellOneItem(fixture, waiterCtx);

    await employees.setEmployeeStatus(ownerCtx, waiter.id, "SUSPENDED");

    const survivingOrder = await prisma.order.findUnique({ where: { id: order.id } });
    const survivingPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(survivingOrder).not.toBeNull();
    expect(survivingPayment).not.toBeNull();
    expect(survivingPayment?.amount.toString()).toBe("120");

    const summary = await reporting.getSalesSummary(ownerCtx, { locationId: "ALL", preset: "today" });
    expect(summary.totalSales).toBe("120");
    expect(summary.completedOrders).toBe(1);

    const byEmployee = await reporting.getSalesByEmployee(ownerCtx, { locationId: "ALL", preset: "today" });
    const row = byEmployee.find((r) => r.employeeId === waiter.id);
    expect(row).toBeDefined();
    expect(row?.employeeName).toBe("Konobar Jedan");
    expect(row?.sales).toBe("120");
  });
});

describe("data retention: menu item archival/deletion", () => {
  it("archiving a menu item does not delete order history; sold-items report still counts it", async () => {
    const fixture = await createFixture();
    const ownerCtx = await createOwnerCtx(fixture);
    const { ctx: waiterCtx } = await createWaiterEmployee(fixture);

    await sellOneItem(fixture, waiterCtx);
    await menu.archiveMenuItem(ownerCtx, fixture.menuItemId);

    const archived = await prisma.menuItem.findUnique({ where: { id: fixture.menuItemId } });
    expect(archived?.deletedAt).not.toBeNull();
    expect(archived?.isActive).toBe(false);

    const soldItems = await reporting.getSoldItems(ownerCtx, { locationId: "ALL", preset: "today" });
    const row = soldItems.rows.find((r) => r.name === "Burger");
    expect(row).toBeDefined();
    expect(row?.quantity).toBe(1);
  });

  it("hard-deleting a menu item leaves the OrderItem snapshot and sales report intact", async () => {
    const fixture = await createFixture();
    const ownerCtx = await createOwnerCtx(fixture);
    const { ctx: waiterCtx } = await createWaiterEmployee(fixture);

    const { order } = await sellOneItem(fixture, waiterCtx);
    await menu.deleteMenuItem(ownerCtx, fixture.menuItemId);

    const deletedMenuItem = await prisma.menuItem.findUnique({ where: { id: fixture.menuItemId } });
    expect(deletedMenuItem).toBeNull();

    const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(orderItems).toHaveLength(1);
    expect(orderItems[0].name).toBe("Burger");
    expect(orderItems[0].price.toString()).toBe("100");
    expect(orderItems[0].menuItemId).toBeNull(); // onDelete: SetNull, not cascade

    const soldItems = await reporting.getSoldItems(ownerCtx, { locationId: "ALL", preset: "today" });
    const row = soldItems.rows.find((r) => r.name === "Burger");
    expect(row).toBeDefined();
    expect(row?.quantity).toBe(1);
  });
});

describe("data retention: device removal", () => {
  it("hard-deleting a device does not touch unrelated historical orders/payments", async () => {
    const fixture = await createFixture();
    const { ctx: waiterCtx } = await createWaiterEmployee(fixture);
    const { order, payment } = await sellOneItem(fixture, waiterCtx);

    const device = await prisma.device.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "POS-1" },
    });
    await prisma.device.delete({ where: { id: device.id } });

    const survivingOrder = await prisma.order.findUnique({ where: { id: order.id } });
    const survivingPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(survivingOrder).not.toBeNull();
    expect(survivingPayment).not.toBeNull();
  });
});
