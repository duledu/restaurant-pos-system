import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, printing } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  kitchenItemId: string;
  barItemId: string;
}

function context(fixture: Fixture, roles: string[], employeeId: string): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles,
    permissions: new Set(["orders.print", "production.view", "production.manage"]),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "AutoPrint tenant", slug: `autoprint-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T9" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const kitchenItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Cevapi",
      slug: `cevapi-${randomUUID()}`,
      price: "700.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });
  const barItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Pivo",
      slug: `pivo-${randomUUID()}`,
      price: "300.00",
      taxRate: "20",
      preparationStation: "BAR",
    },
  });

  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, kitchenItemId: kitchenItem.id, barItemId: barItem.id };
}

async function submitMixedOrder(fixture: Fixture, waiter: AuthContext) {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
  await orders.addItem(waiter, order.id, { menuItemId: fixture.barItemId, quantity: 1 });
  return orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("automatic print dispatch: paper width snapshot per station", () => {
  it("defaults to 80mm for both stations when no PrinterConfig exists", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    const barJob = jobs.find((j) => j.type === "BAR")!;
    expect((kitchenJob.content as { paperWidthMm: number }).paperWidthMm).toBe(80);
    expect((barJob.content as { paperWidthMm: number }).paperWidthMm).toBe(80);
  });

  it("Kitchen and Bar can carry independent paper widths (80mm vs 58mm) on the same order", async () => {
    const fixture = await createFixture();
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", paperWidthMm: 80 },
    });
    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "BAR", name: "Šank", paperWidthMm: 58 },
    });
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    const barJob = jobs.find((j) => j.type === "BAR")!;
    expect((kitchenJob.content as { paperWidthMm: number }).paperWidthMm).toBe(80);
    expect((barJob.content as { paperWidthMm: number }).paperWidthMm).toBe(58);
  });
});

describe("automatic print dispatch: atomic claim (beginPrintAttempt) prevents duplicate auto-print", () => {
  it("claims a PENDING job exactly once under concurrent auto-print attempts (refresh/poll/retry race)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;

    const attempts = await Promise.all([
      printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id),
      printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id),
      printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id),
      printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id),
      printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id),
    ]);
    const claimed = attempts.filter((a) => a !== null);
    expect(claimed).toHaveLength(1);

    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } });
    expect(row.status).toBe("PRINTING");
    expect(row.attemptCount).toBe(1);
  });

  it("refuses to claim a job that is not PENDING (already PRINTING/PRINTED/FAILED) — no re-trigger on refresh after a completed attempt", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;

    const first = await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    expect(first).not.toBeNull();
    await printing.confirmPrintResult(kitchenStaff, submitted.id, kitchenJob.id, { success: true });

    // Simulates the KDS screen re-discovering the same job on the next 4s
    // poll or a full page refresh — it must never fire window.print() again.
    const second = await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    expect(second).toBeNull();
  });

  it("a KITCHEN-role employee cannot claim a BAR print job (station RBAC, same guard as the KDS screen)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const barJob = jobs.find((j) => j.type === "BAR")!;

    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    await expect(printing.beginPrintAttempt(kitchenStaff, submitted.id, barJob.id)).rejects.toThrow();
  });

  it("recovers a stale PRINTING claim back to PENDING (tab/browser crash after claim, before confirm) — never permanently lost, never re-triggers business effects", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;

    const claimed = await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    expect(claimed).not.toBeNull();

    // Simulate the claiming tab/browser crashing before confirmPrintResult
    // ever runs — backdate updatedAt past STALE_PRINT_LEASE_MS (90s), the
    // same signal listPendingStationPrintJobs checks (see print-service.ts).
    await prisma.printJob.update({
      where: { id: kitchenJob.id },
      data: { updatedAt: new Date(Date.now() - 91_000) },
    });

    const result = await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");
    const recovered = result.jobs.find((j) => j.id === kitchenJob.id);
    expect(recovered?.status).toBe("PENDING");

    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } });
    expect(row.status).toBe("PENDING");
    // Recovery only resets status — it must never touch the order/KDS state
    // that already exists independently of this print job.
    expect(await prisma.order.count({ where: { id: submitted.id } })).toBe(1);
    expect(await prisma.orderItemStation.count({ where: { orderItem: { orderId: submitted.id }, station: "KITCHEN" } })).toBeGreaterThan(0);

    // Recovered job is claimable again exactly once — same idempotent path
    // as any other PENDING job, no second/competing recovery queue.
    const reclaimed = await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.status).toBe("PRINTING");
  });

  it("does NOT recover a PRINTING claim that is still within the lease window (fresh in-progress print is left alone)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;

    await printing.beginPrintAttempt(kitchenStaff, submitted.id, kitchenJob.id);
    await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");

    const row = await prisma.printJob.findUniqueOrThrow({ where: { id: kitchenJob.id } });
    expect(row.status).toBe("PRINTING");
  });
});

describe("automatic print dispatch: station queue listing", () => {
  it("KITCHEN listing returns only KITCHEN jobs (PENDING + FAILED), never BAR", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    // Management sees both stations (assertStationAccess) — a single
    // realistic actor can't hold both KITCHEN and BAR roles at once, and
    // that cross-station denial is proven separately above.
    const manager = context(fixture, ["MANAGER"], "manager-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const barJob = jobs.find((j) => j.type === "BAR")!;
    await printing.confirmPrintResult(manager, submitted.id, barJob.id, { success: false, errorMessage: "Printer offline" });

    const kitchenResult = await printing.listPendingStationPrintJobs(manager, fixture.locationId, "KITCHEN");
    expect(kitchenResult.jobs.every((j) => j.station === "KITCHEN")).toBe(true);
    expect(kitchenResult.jobs.some((j) => j.status === "PENDING")).toBe(true);

    const barResult = await printing.listPendingStationPrintJobs(manager, fixture.locationId, "BAR");
    expect(barResult.jobs).toHaveLength(1);
    expect(barResult.jobs[0].status).toBe("FAILED");
  });

  it("excludes PRINTED jobs from the pending/failed listing (no re-surfacing an already-printed ticket)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, ["WAITER"], "waiter-1");
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");
    const submitted = await submitMixedOrder(fixture, waiter);
    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN")!;
    await printing.confirmPrintResult(kitchenStaff, submitted.id, kitchenJob.id, { success: true });

    const result = await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");
    expect(result.jobs).toHaveLength(0);
  });

  it("autoPrintEligible defaults to true with no PrinterConfig row, and reflects isEnabled=false once configured", async () => {
    const fixture = await createFixture();
    const kitchenStaff = context(fixture, ["KITCHEN"], "kitchen-1");

    const beforeConfig = await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");
    expect(beforeConfig.autoPrintEligible).toBe(true);

    await prisma.printerConfig.create({
      data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, station: "KITCHEN", name: "Kuhinja", isEnabled: false },
    });
    const afterConfig = await printing.listPendingStationPrintJobs(kitchenStaff, fixture.locationId, "KITCHEN");
    expect(afterConfig.autoPrintEligible).toBe(false);
  });
});
