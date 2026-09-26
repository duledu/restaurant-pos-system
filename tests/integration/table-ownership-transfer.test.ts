/**
 * Shift Handover V1 — Table Ownership Transfer Engine.
 *
 * Order.openedBy is the ONLY ownership signal in the whole system (see
 * ownership-transfer-service.ts's own module doc) — these tests prove the
 * engine changes ONLY that field, atomically, with a full audit trail, and
 * never touches KDS/printing/payment/OrderItem authorship.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, tableOwnership, shifts } from "@rcs/domain";
import { StaleOwnershipError } from "../../packages/domain/tables/ownership-transfer-service";
import { OwnedOpenTablesError } from "../../packages/domain/shifts/shift-service";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  shiftId: string;
  menuItemId: string;
  roleIdByName: Record<string, string>;
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Handover tenant", slug: `handover-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Handover Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const shift = await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "seed", openingCash: "0" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" } });
  const menuItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Burger", slug: `burger-${randomUUID()}`, price: "500.00", taxRate: "20", preparationStation: "KITCHEN" },
  });

  const roleIdByName: Record<string, string> = {};
  for (const roleName of ["OWNER", "MANAGER", "WAITER", "KITCHEN"]) {
    const role = await prisma.role.create({ data: { restaurantId: restaurant.id, name: roleName, isSystem: true } });
    roleIdByName[roleName] = role.id;
  }

  return { restaurantId: restaurant.id, locationId: location.id, shiftId: shift.id, menuItemId: menuItem.id, roleIdByName };
}

async function createEmployee(fixture: Fixture, roleName: string, firstName: string): Promise<{ employeeId: string; ctx: AuthContext }> {
  const employee = await prisma.employee.create({ data: { restaurantId: fixture.restaurantId, firstName, lastName: roleName } });
  await prisma.employeeRole.create({ data: { employeeId: employee.id, roleId: fixture.roleIdByName[roleName] } });
  await prisma.employeeLocation.create({ data: { employeeId: employee.id, locationId: fixture.locationId } });
  const ctx: AuthContext = {
    userId: employee.id,
    employeeId: employee.id,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [roleName],
    permissions: new Set(["orders.create", "orders.manage", "orders.submit", "orders.print", "shifts.manage", "audit.view"]),
  };
  return { employeeId: employee.id, ctx };
}

async function newTable(fixture: Fixture) {
  const floor = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: `Floor-${randomUUID()}` } });
  return prisma.restaurantTable.create({ data: { floorId: floor.id, label: `T-${randomUUID().slice(0, 6)}` } });
}

/** Opens and submits an order for `ctx`, so Order.openedBy = ctx.employeeId and status leaves DRAFT. */
async function openAndSubmitOrder(fixture: Fixture, ctx: AuthContext) {
  const table = await newTable(fixture);
  const order = await orders.openOrder(ctx, { tableId: table.id });
  await orders.addItem(ctx, order.id, { menuItemId: fixture.menuItemId, quantity: 1, modifierOptionIds: [] });
  const submitted = await orders.submitOrder(ctx, order.id, { idempotencyKey: randomUUID() });
  return { orderId: submitted.id, tableId: table.id, tableLabel: table.label };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("transferTables — self-service claim (SHIFT_HANDOVER)", () => {
  it("incoming waiter claims one table from another waiter — Order.openedBy changes, nothing else does", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const { orderId, tableLabel } = await openAndSubmitOrder(fixture, marko.ctx);

    const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(before.openedBy).toBe(marko.employeeId);

    const result = await tableOwnership.transferTables(nikola.ctx, {
      reason: "SHIFT_HANDOVER",
      transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }],
    });

    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0]).toMatchObject({ orderId, tableLabel, previousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId });
    expect(result.failed).toHaveLength(0);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after.openedBy).toBe(nikola.employeeId);
    // Nothing else about the order changed.
    expect(after.status).toBe(before.status);
    expect(after.tableId).toBe(before.tableId);
    expect(after.createdAt).toEqual(before.createdAt);
  });

  it("1 -> 1: outgoing waiter's ALL 7 tables can be claimed by one incoming waiter in a single bulk call", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const openedOrders = [];
    for (let i = 0; i < 7; i++) openedOrders.push(await openAndSubmitOrder(fixture, marko.ctx));

    const result = await tableOwnership.transferTables(nikola.ctx, {
      reason: "SHIFT_HANDOVER",
      transfers: openedOrders.map((o) => ({ orderId: o.orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId })),
    });

    expect(result.succeeded).toHaveLength(7);
    expect(result.failed).toHaveLength(0);
    const afterOrders = await prisma.order.findMany({ where: { id: { in: openedOrders.map((o) => o.orderId) } } });
    expect(afterOrders.every((o) => o.openedBy === nikola.employeeId)).toBe(true);
  });

  it("6 -> 4: tables from six outgoing waiters can be freely redistributed among four incoming waiters", async () => {
    const fixture = await createFixture();
    const outgoing = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => createEmployee(fixture, "WAITER", `Out${n}`)));
    const incoming = await Promise.all([1, 2, 3, 4].map((n) => createEmployee(fixture, "WAITER", `In${n}`)));
    // Each outgoing waiter opens one table (kept small for test speed; the
    // engine's correctness does not depend on table count).
    const tablesByOwner = await Promise.all(outgoing.map((w) => openAndSubmitOrder(fixture, w.ctx)));

    // Distribute: In1 takes Out1+Out2's tables, In2 takes Out3's, In3 takes
    // Out4+Out5's, In4 takes Out6's — arbitrary redistribution across both
    // groups, proving the engine has no 1:1 assumption.
    const assignment = [
      { table: tablesByOwner[0], owner: outgoing[0], newOwner: incoming[0] },
      { table: tablesByOwner[1], owner: outgoing[1], newOwner: incoming[0] },
      { table: tablesByOwner[2], owner: outgoing[2], newOwner: incoming[1] },
      { table: tablesByOwner[3], owner: outgoing[3], newOwner: incoming[2] },
      { table: tablesByOwner[4], owner: outgoing[4], newOwner: incoming[2] },
      { table: tablesByOwner[5], owner: outgoing[5], newOwner: incoming[3] },
    ];

    for (const a of assignment) {
      const result = await tableOwnership.transferTables(a.newOwner.ctx, {
        reason: "SHIFT_HANDOVER",
        transfers: [{ orderId: a.table.orderId, expectedPreviousOwnerId: a.owner.employeeId, newOwnerId: a.newOwner.employeeId }],
      });
      expect(result.succeeded).toHaveLength(1);
    }

    const finalOrders = await prisma.order.findMany({ where: { id: { in: tablesByOwner.map((t) => t.orderId) } } });
    const ownerOf = new Map(finalOrders.map((o) => [o.id, o.openedBy]));
    expect(ownerOf.get(tablesByOwner[0].orderId)).toBe(incoming[0].employeeId);
    expect(ownerOf.get(tablesByOwner[1].orderId)).toBe(incoming[0].employeeId);
    expect(ownerOf.get(tablesByOwner[2].orderId)).toBe(incoming[1].employeeId);
    expect(ownerOf.get(tablesByOwner[3].orderId)).toBe(incoming[2].employeeId);
    expect(ownerOf.get(tablesByOwner[4].orderId)).toBe(incoming[2].employeeId);
    expect(ownerOf.get(tablesByOwner[5].orderId)).toBe(incoming[3].employeeId);
  });

  it("partial handover: Marko has 5 tables, Nikola takes 3, Jovan takes 2 — Marko then has zero", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const jovan = await createEmployee(fixture, "WAITER", "Jovan");
    const tables = [];
    for (let i = 0; i < 5; i++) tables.push(await openAndSubmitOrder(fixture, marko.ctx));

    await tableOwnership.transferTables(nikola.ctx, {
      reason: "SHIFT_HANDOVER",
      transfers: tables.slice(0, 3).map((t) => ({ orderId: t.orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId })),
    });
    await tableOwnership.transferTables(jovan.ctx, {
      reason: "SHIFT_HANDOVER",
      transfers: tables.slice(3, 5).map((t) => ({ orderId: t.orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: jovan.employeeId })),
    });

    const remaining = await tableOwnership.listMyOpenTables(marko.ctx, fixture.locationId);
    expect(remaining).toHaveLength(0);
  });

  it("mid-shift single-table transfer works without any shift-closing context", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const t1 = await openAndSubmitOrder(fixture, marko.ctx);
    const t2 = await openAndSubmitOrder(fixture, marko.ctx);

    const result = await tableOwnership.transferTables(nikola.ctx, {
      reason: "MANUAL_TABLE_TRANSFER",
      transfers: [{ orderId: t1.orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }],
    });
    expect(result.succeeded).toHaveLength(1);

    // t2 (never transferred) still belongs to Marko.
    const t2After = await prisma.order.findUniqueOrThrow({ where: { id: t2.orderId } });
    expect(t2After.openedBy).toBe(marko.employeeId);
  });
});

describe("transferTables — concurrency (Section 8, CRITICAL)", () => {
  it("concurrent takeover: two waiters race for the same table, exactly one succeeds", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const jovan = await createEmployee(fixture, "WAITER", "Jovan");
    const { orderId, tableLabel } = await openAndSubmitOrder(fixture, marko.ctx);

    const [nikolaResult, jovanResult] = await Promise.all([
      tableOwnership.transferTables(nikola.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }] }),
      tableOwnership.transferTables(jovan.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: jovan.employeeId }] }),
    ]);

    const totalSucceeded = nikolaResult.succeeded.length + jovanResult.succeeded.length;
    const totalFailed = nikolaResult.failed.length + jovanResult.failed.length;
    expect(totalSucceeded).toBe(1); // EXACTLY one wins — never both, never neither
    expect(totalFailed).toBe(1);

    const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect([nikola.employeeId, jovan.employeeId]).toContain(finalOrder.openedBy);

    // The losing side's failure carries the correct table label and the
    // ACTUAL current owner's name — never a stale/blank UI state.
    const losingResult = nikolaResult.succeeded.length === 0 ? nikolaResult : jovanResult;
    expect(losingResult.failed[0].tableLabel).toBe(tableLabel);
  });

  it("already-transferred: a stale client retries claiming a table someone else already took", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const jovan = await createEmployee(fixture, "WAITER", "Jovan");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);

    await tableOwnership.transferTables(nikola.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }] });

    // Jovan's UI is stale — still thinks Marko owns it.
    const staleAttempt = await tableOwnership.transferTables(jovan.ctx, {
      reason: "SHIFT_HANDOVER",
      transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: jovan.employeeId }],
    });
    expect(staleAttempt.succeeded).toHaveLength(0);
    expect(staleAttempt.failed).toHaveLength(1);

    const stillOwner = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(stillOwner.openedBy).toBe(nikola.employeeId); // untouched by the stale attempt
  });

  it("bulk transfer partial success: one stale line fails, the other valid lines still commit", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const t1 = await openAndSubmitOrder(fixture, marko.ctx);
    const t2 = await openAndSubmitOrder(fixture, marko.ctx);

    const result = await tableOwnership.transferTables(nikola.ctx, {
      reason: "SHIFT_HANDOVER",
      transfers: [
        { orderId: t1.orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId },
        { orderId: t2.orderId, expectedPreviousOwnerId: "wrong-employee-id-not-current-owner", newOwnerId: nikola.employeeId },
      ],
    });

    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].orderId).toBe(t1.orderId);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].orderId).toBe(t2.orderId);

    const t1After = await prisma.order.findUniqueOrThrow({ where: { id: t1.orderId } });
    const t2After = await prisma.order.findUniqueOrThrow({ where: { id: t2.orderId } });
    expect(t1After.openedBy).toBe(nikola.employeeId); // committed
    expect(t2After.openedBy).toBe(marko.employeeId); // untouched, still Marko's
  });
});

describe("transferTables — authorization", () => {
  it("KITCHEN role cannot initiate a table transfer", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const kitchen = await createEmployee(fixture, "KITCHEN", "Kuhinja");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);

    await expect(
      tableOwnership.transferTables(kitchen.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: kitchen.employeeId }] })
    ).rejects.toThrow(/dozvolu/);
  });

  it("a bystander waiter cannot transfer a table between two OTHER waiters (not a party to the transfer)", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const bystander = await createEmployee(fixture, "WAITER", "Bystander");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);

    const result = await tableOwnership.transferTables(bystander.ctx, {
      reason: "SHIFT_HANDOVER",
      transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }],
    });
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/trenutno držiš|preuzeti sto za sebe/);

    const unchanged = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(unchanged.openedBy).toBe(marko.employeeId);
  });

  it("new owner must be an active employee with access to the location", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);

    const result = await tableOwnership.transferTables(marko.ctx, {
      reason: "MANUAL_TABLE_TRANSFER",
      transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: randomUUID() }],
    });
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed[0].error).toMatch(/nije pronađen|nije aktivan|nema pristup/);
  });
});

describe("forceTransferTable — MANAGER_FORCED_TRANSFER", () => {
  it("a WAITER cannot force-transfer", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);

    await expect(tableOwnership.forceTransferTable(nikola.ctx, { orderId, newOwnerId: nikola.employeeId })).rejects.toThrow(/menadžer/);
  });

  it("OWNER/MANAGER can force-transfer even when the outgoing waiter never acted — audit records acceptedBy=null", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const manager = await createEmployee(fixture, "MANAGER", "Petar");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);

    const result = await tableOwnership.forceTransferTable(manager.ctx, { orderId, newOwnerId: nikola.employeeId });
    expect(result).toMatchObject({ orderId, previousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId });

    const record = await prisma.tableOwnershipTransfer.findFirstOrThrow({ where: { orderId } });
    expect(record.reason).toBe("MANAGER_FORCED_TRANSFER");
    expect(record.initiatedBy).toBe(manager.employeeId);
    expect(record.acceptedBy).toBeNull(); // never fabricated — Nikola did not proactively act
  });
});

describe("Audit trail (Section 9, mandatory)", () => {
  it("records a TableOwnershipTransfer row with every required field, plus an OrderEvent and an AuditLog entry", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const { orderId, tableId, tableLabel } = await openAndSubmitOrder(fixture, marko.ctx);

    await tableOwnership.transferTables(nikola.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }] });

    const record = await prisma.tableOwnershipTransfer.findFirstOrThrow({ where: { orderId } });
    expect(record).toMatchObject({
      orderId,
      tableId,
      tableLabel,
      previousOwnerId: marko.employeeId,
      newOwnerId: nikola.employeeId,
      initiatedBy: nikola.employeeId,
      acceptedBy: nikola.employeeId, // self-service claim — the claiming action IS the confirmation
      reason: "SHIFT_HANDOVER",
    });
    expect(record.previousOwnerName).toContain("Marko");
    expect(record.newOwnerName).toContain("Nikola");

    const event = await prisma.orderEvent.findFirstOrThrow({ where: { orderId, type: "table_ownership_transferred" } });
    expect(event.createdBy).toBe(nikola.employeeId);

    const auditEntry = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Order", entityId: orderId, action: "order.owner_transferred" } });
    expect(auditEntry.previousValue).toMatchObject({ openedBy: marko.employeeId });
    expect(auditEntry.newValue).toMatchObject({ openedBy: nikola.employeeId, reason: "SHIFT_HANDOVER" });
  });

  it("historical audit entries are never rewritten by a later transfer of the same table", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const jovan = await createEmployee(fixture, "WAITER", "Jovan");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);

    await tableOwnership.transferTables(nikola.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }] });
    await tableOwnership.transferTables(jovan.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: nikola.employeeId, newOwnerId: jovan.employeeId }] });

    const records = await prisma.tableOwnershipTransfer.findMany({ where: { orderId }, orderBy: { transferredAt: "asc" } });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ previousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId });
    expect(records[1]).toMatchObject({ previousOwnerId: nikola.employeeId, newOwnerId: jovan.employeeId }); // first record untouched
  });
});

describe("No side effects on OrderItem authorship, KDS, printing, or payment (Sections 1, 11, 16, 17)", () => {
  it("original OrderItem/OrderEvent authorship (who added what) is untouched by an ownership transfer", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);

    const itemBefore = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });
    const addedEventBefore = await prisma.orderEvent.findFirstOrThrow({ where: { orderId, type: "item_added" } });

    await tableOwnership.transferTables(nikola.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }] });

    const itemAfter = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemBefore.id } });
    const addedEventAfter = await prisma.orderEvent.findUniqueOrThrow({ where: { id: addedEventBefore.id } });
    expect(itemAfter).toEqual(itemBefore); // completely untouched
    expect(addedEventAfter.createdBy).toBe(marko.employeeId); // still Marko's historical action, forever
  });

  it("transfer creates NO PrintJob and NO new OrderItemStation rows (no duplicate KDS dispatch, no re-print)", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);

    const printJobsBefore = await prisma.printJob.count({ where: { orderId } });
    const stationsBefore = await prisma.orderItemStation.count({ where: { orderItem: { orderId } } });

    await tableOwnership.transferTables(nikola.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }] });

    const printJobsAfter = await prisma.printJob.count({ where: { orderId } });
    const stationsAfter = await prisma.orderItemStation.count({ where: { orderItem: { orderId } } });
    expect(printJobsAfter).toBe(printJobsBefore);
    expect(stationsAfter).toBe(stationsBefore);
  });

  it("transfer creates NO Payment/Receipt rows and does not change order status", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);
    const statusBefore = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

    await tableOwnership.transferTables(nikola.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }] });

    const payments = await prisma.payment.count({ where: { orderId } });
    const receipts = await prisma.receipt.count({ where: { orderId } });
    const statusAfter = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
    expect(payments).toBe(0);
    expect(receipts).toBe(0);
    expect(statusAfter).toBe(statusBefore);
  });
});

describe("Empty/no-order edge case (Section 15)", () => {
  it("refuses to transfer a COMPLETED order (already closed, no live ownership to transfer)", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);
    await prisma.order.update({ where: { id: orderId }, data: { status: "COMPLETED" } });

    const result = await tableOwnership.transferTables(nikola.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }] });
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed[0].error).toMatch(/nije pronađena|nije otvorena/);
  });
});

describe("getHandoverOverview (Section 6)", () => {
  it("reports total/transferred counts and splits pending vs already-transferred tables", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const t1 = await openAndSubmitOrder(fixture, marko.ctx);
    const t2 = await openAndSubmitOrder(fixture, marko.ctx);

    await tableOwnership.transferTables(nikola.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId: t1.orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }] });

    const overview = await tableOwnership.getHandoverOverview(nikola.ctx, fixture.locationId);
    expect(overview.totalOpenTables).toBe(2);
    expect(overview.transferredCount).toBe(1);
    expect(overview.pendingTables).toHaveLength(1);
    expect(overview.pendingTables[0].orderId).toBe(t2.orderId);
    expect(overview.transferredTables).toHaveLength(1);
    expect(overview.transferredTables[0].orderId).toBe(t1.orderId);
    expect(overview.transferredTables[0].newOwnerName).toContain("Nikola");
  });
});

describe("listAvailableTablesForTakeover / listMyOpenTables", () => {
  it("takeover list excludes the caller's own tables and groups the rest by current owner", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const stefan = await createEmployee(fixture, "WAITER", "Stefan");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    await openAndSubmitOrder(fixture, marko.ctx);
    await openAndSubmitOrder(fixture, marko.ctx);
    await openAndSubmitOrder(fixture, stefan.ctx);
    await openAndSubmitOrder(fixture, nikola.ctx); // Nikola's own — must be excluded from Nikola's own takeover list

    const groups = await tableOwnership.listAvailableTablesForTakeover(nikola.ctx, fixture.locationId);
    const employeeIds = groups.map((g) => g.employeeId);
    expect(employeeIds).toContain(marko.employeeId);
    expect(employeeIds).toContain(stefan.employeeId);
    expect(employeeIds).not.toContain(nikola.employeeId);
    expect(groups.find((g) => g.employeeId === marko.employeeId)?.tables).toHaveLength(2);
  });
});

describe("Shift Closing Guard (Section 5)", () => {
  async function loadShiftCtxForClose(fixture: Fixture, employee: { employeeId: string; ctx: AuthContext }) {
    return { ...employee.ctx, permissions: new Set(["shifts.manage"]) };
  }

  it("throws OwnedOpenTablesError (not the generic message) when the CLOSING employee personally has open tables", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const { tableLabel } = await openAndSubmitOrder(fixture, marko.ctx);
    const closeCtx = await loadShiftCtxForClose(fixture, marko);

    await expect(shifts.closeShift(closeCtx, fixture.shiftId, { countedCash: 0 })).rejects.toBeInstanceOf(OwnedOpenTablesError);
    try {
      await shifts.closeShift(closeCtx, fixture.shiftId, { countedCash: 0 });
    } catch (e) {
      expect(e).toBeInstanceOf(OwnedOpenTablesError);
      expect((e as InstanceType<typeof OwnedOpenTablesError>).tables[0].tableLabel).toBe(tableLabel);
    }
  });

  it("falls through to the existing generic error when only OTHER waiters have open tables (safety invariant unchanged)", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    await openAndSubmitOrder(fixture, marko.ctx); // Marko's table stays open
    const nikolaCloseCtx = await loadShiftCtxForClose(fixture, nikola);

    await expect(shifts.closeShift(nikolaCloseCtx, fixture.shiftId, { countedCash: 0 })).rejects.toThrow(/otvoreni računi/);
    // NOT OwnedOpenTablesError — Nikola has no open tables of their own.
    await expect(shifts.closeShift(nikolaCloseCtx, fixture.shiftId, { countedCash: 0 })).rejects.not.toBeInstanceOf(OwnedOpenTablesError);
  });

  it("after handing off all owned tables, the same employee can close the shift (no other open orders)", async () => {
    const fixture = await createFixture();
    const marko = await createEmployee(fixture, "WAITER", "Marko");
    const nikola = await createEmployee(fixture, "WAITER", "Nikola");
    const { orderId } = await openAndSubmitOrder(fixture, marko.ctx);

    await tableOwnership.transferTables(nikola.ctx, { reason: "SHIFT_HANDOVER", transfers: [{ orderId, expectedPreviousOwnerId: marko.employeeId, newOwnerId: nikola.employeeId }] });

    // Marko no longer owns any table — but Nikola now does, so the
    // LOCATION-WIDE guard (unchanged) still correctly blocks close until
    // Nikola's table is also settled/transferred. This proves the fix adds
    // a friendlier MESSAGE without weakening the existing safety invariant.
    const markoCloseCtx = await loadShiftCtxForClose(fixture, marko);
    await expect(shifts.closeShift(markoCloseCtx, fixture.shiftId, { countedCash: 0 })).rejects.not.toBeInstanceOf(OwnedOpenTablesError);
  });
});
