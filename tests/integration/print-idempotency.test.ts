import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, printing } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  menuItemId: string;
}

function context(fixture: Fixture, role: string, employeeId: string): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(["orders.print", "production.view", "production.manage"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Idem tenant", slug: `idem-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
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
      price: "1200.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });
  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, menuItemId: menuItem.id };
}

async function submitOrder(fixture: Fixture, waiter: AuthContext) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.menuItemId, quantity: 1 });
  return orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

afterAll(async () => prisma.$disconnect());

describe("print idempotency: duplicate dispatch never creates duplicate PrintJob rows", () => {
  it("submitOrder's own auto-dispatch already creates exactly one KITCHEN job", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await submitOrder(fixture, waiter);

    expect(await prisma.printJob.count({ where: { orderId: submitted.id, type: "KITCHEN" } })).toBe(1);
  });

  it("re-invoking dispatch for the same order (simulating a page refresh/retry) does not create a second row", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await submitOrder(fixture, waiter);

    await printing.dispatchStationPrintJobs(waiter, submitted.id);
    await printing.dispatchStationPrintJobs(waiter, submitted.id);
    await printing.dispatchStationPrintJobs(waiter, submitted.id);

    expect(await prisma.printJob.count({ where: { orderId: submitted.id, type: "KITCHEN" } })).toBe(1);
  });

  it("concurrent dispatch calls for the same order are race-safe via the unique constraint", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await submitOrder(fixture, waiter);

    const results = await Promise.allSettled([
      printing.dispatchStationPrintJobs(waiter, submitted.id),
      printing.dispatchStationPrintJobs(waiter, submitted.id),
      printing.dispatchStationPrintJobs(waiter, submitted.id),
    ]);
    // Upsert semantics: every call resolves (no error), and exactly one row exists.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.printJob.count({ where: { orderId: submitted.id, type: "KITCHEN" } })).toBe(1);
  });

  it("retrying a FAILED print job resets the SAME row to PENDING rather than creating a new one", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await submitOrder(fixture, waiter);

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const job = jobs.find((j) => j.type === "KITCHEN")!;
    await printing.confirmPrintResult(waiter, submitted.id, job.id, { success: false, errorMessage: "Printer offline" });

    const failed = await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.failureReason).toBe("Printer offline");

    const retried = await printing.retryPrintJob(waiter, submitted.id, job.id);
    expect(retried.id).toBe(job.id);
    expect(retried.status).toBe("PENDING");
    expect(retried.failureReason).toBeNull();
    expect(await prisma.printJob.count({ where: { orderId: submitted.id, type: "KITCHEN" } })).toBe(1);
  });

  it("rejects retrying a job that is not currently FAILED", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await submitOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const job = jobs.find((j) => j.type === "KITCHEN")!;

    await expect(printing.retryPrintJob(waiter, submitted.id, job.id)).rejects.toThrow("može da se ponovi");
  });

  it("confirming a successful print sets PRINTED status and printedAt, and increments attemptCount", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const submitted = await submitOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const job = jobs.find((j) => j.type === "KITCHEN")!;

    const confirmed = await printing.confirmPrintResult(waiter, submitted.id, job.id, { success: true });
    expect(confirmed.status).toBe("PRINTED");
    expect(confirmed.printedAt).not.toBeNull();
    expect(confirmed.attemptCount).toBe(1);
  });
});
