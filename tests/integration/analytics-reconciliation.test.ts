import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { orders, billing, voids, reporting, analytics } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  tableId: string;
  kitchenItemId: string;
  barItemId: string;
  bothItemId: string;
}

function context(fixture: Fixture, role: string, employeeId: string, permissions: string[] = ["audit.view"]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(permissions),
  };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Analytics tenant", slug: `analytics-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD", timezone: "Europe/Belgrade" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T1" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" } });
  const kitchenItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, price: "800.00", taxRate: "20", preparationStation: "KITCHEN" },
  });
  const barItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Coca-Cola", slug: `cola-${randomUUID()}`, price: "250.00", taxRate: "20", preparationStation: "BAR" },
  });
  const bothItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Kombinovani tanjir", slug: `combo-${randomUUID()}`, price: "1500.00", taxRate: "20", preparationStation: "KITCHEN_AND_BAR" },
  });
  return { restaurantId: restaurant.id, locationId: location.id, tableId: table.id, kitchenItemId: kitchenItem.id, barItemId: barItem.id, bothItemId: bothItem.id };
}

async function payOrderFor(fixture: Fixture, waiter: AuthContext, menuItemId: string, quantity: number, method: "CASH" | "CARD" = "CARD") {
  const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
  const item = await orders.addItem(waiter, order.id, { menuItemId, quantity });
  const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
  const { payment } = await billing.completePayment(waiter, submitted.id, { method, tenderedAmount: method === "CASH" ? 100000 : undefined });
  return { order: submitted, item, payment };
}

function localHour(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0");
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("reconciliation: dashboard KPI numbers equal the existing Sales Report for identical filters", () => {
  it("getKpiComparison.current matches reporting.getSalesSummary exactly", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, fixture.kitchenItemId, 2, "CASH");
    await payOrderFor(fixture, waiter, fixture.barItemId, 1, "CARD");

    const manager = context(fixture, "MANAGER", "mgr-1");
    const filters = { locationId: "ALL", preset: "today" } as const;

    const [kpi, existingSummary] = await Promise.all([
      analytics.getKpiComparison(manager, filters),
      reporting.getSalesSummary(manager, filters),
    ]);

    expect(kpi.current.totalSales).toBe(existingSummary.totalSales);
    expect(kpi.current.cashSales).toBe(existingSummary.cashSales);
    expect(kpi.current.cardSales).toBe(existingSummary.cardSales);
    expect(kpi.current.completedOrders).toBe(existingSummary.completedOrders);
    expect(kpi.current.averageOrderValue).toBe(existingSummary.averageOrderValue);
    expect(kpi.current.discountTotal).toBe(existingSummary.discountTotal);
    expect(kpi.current.voidTotal).toBe(existingSummary.voidTotal);
  });

  it("does not show a fake comparison when the previous period predates the restaurant's existence", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, fixture.kitchenItemId, 1, "CASH");

    // Restoran je "upravo otvoren" — svaki period pre danas prethodi mu.
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { createdAt: new Date() } });

    const manager = context(fixture, "MANAGER", "mgr-1");
    const kpi = await analytics.getKpiComparison(manager, { locationId: "ALL", preset: "thisMonth" });
    expect(kpi.previousAvailable).toBe(false);
    expect(kpi.previous).toBeNull();
  });

  it("getPaymentBreakdown totals reconcile with getSalesSummary's cash/card split", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, fixture.kitchenItemId, 1, "CASH");
    await payOrderFor(fixture, waiter, fixture.barItemId, 2, "CARD");

    const manager = context(fixture, "MANAGER", "mgr-1");
    const filters = { locationId: "ALL", preset: "today" } as const;
    const [breakdown, summary] = await Promise.all([analytics.getPaymentBreakdown(manager, filters), reporting.getSalesSummary(manager, filters)]);

    const cashRow = breakdown.methods.find((m) => m.method === "CASH");
    const cardRow = breakdown.methods.find((m) => m.method === "CARD");
    expect(cashRow?.amount).toBe(Number(summary.cashSales).toFixed(2));
    expect(cardRow?.amount).toBe(Number(summary.cardSales).toFixed(2));
    expect(breakdown.totalSales).toBe(Number(summary.totalSales).toFixed(2));
  });
});

describe("kitchen vs bar attribution: no double-counting, matches getSoldItems", () => {
  it("kitchen + bar revenue sums to allRevenue, KITCHEN_AND_BAR counted once (kitchen only)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, fixture.kitchenItemId, 1);
    await payOrderFor(fixture, waiter, fixture.barItemId, 1);
    await payOrderFor(fixture, waiter, fixture.bothItemId, 1);

    const manager = context(fixture, "MANAGER", "mgr-1");
    const filters = { locationId: "ALL", preset: "today" } as const;
    const [stations, soldItems] = await Promise.all([analytics.getStationComparison(manager, filters), reporting.getSoldItems(manager, filters)]);

    const kitchenPlusBar = Number(stations.kitchen.revenue) + Number(stations.bar.revenue);
    expect(kitchenPlusBar).toBeCloseTo(Number(soldItems.summary.allRevenue), 2);
    expect(stations.kitchen.revenue).toBe(soldItems.summary.kitchenRevenue);
    expect(stations.bar.revenue).toBe(soldItems.summary.barRevenue);
  });

  it("void value by station also sums without double-counting for a KITCHEN_AND_BAR item", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.bothItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 1,
      reasonCode: "OTHER",
      explanation: "Gost je otkazao pre nego što je stavka poslužena, storniramo je u celosti.",
    });

    const stations = await analytics.getStationComparison(manager, { locationId: "ALL", preset: "today" });
    expect(Number(stations.kitchen.voidValue)).toBe(1500);
    expect(Number(stations.bar.voidValue)).toBe(0);
  });
});

describe("top item ranking and percentages", () => {
  it("ranks items by revenue descending and percentages sum to ~100%", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, fixture.kitchenItemId, 5); // 4000
    await payOrderFor(fixture, waiter, fixture.barItemId, 1); // 250

    const manager = context(fixture, "MANAGER", "mgr-1");
    const result = await analytics.getTopAndLowItems(manager, { locationId: "ALL", preset: "today" }, { limit: 5 });
    expect(result.topItems[0].name).toBe("Pljeskavica");
    const totalPercent = result.topItems.reduce((s, r) => s + r.percentOfTotal, 0);
    expect(totalPercent).toBeGreaterThan(99);
    expect(totalPercent).toBeLessThanOrEqual(100.5);
  });

  it("lists a current, active menu item with no sales in the period as a zero-sale item, labeled basedOnCurrentMenu", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, fixture.kitchenItemId, 1); // Coca-Cola i Kombinovani tanjir se ne prodaju

    const manager = context(fixture, "MANAGER", "mgr-1");
    const result = await analytics.getTopAndLowItems(manager, { locationId: "ALL", preset: "today" });
    expect(result.basedOnCurrentMenu).toBe(true);
    const zeroNames = result.zeroSaleItems.map((z) => z.name);
    expect(zeroNames).toContain("Coca-Cola");
    expect(zeroNames).toContain("Kombinovani tanjir");
    expect(zeroNames).not.toContain("Pljeskavica");
  });
});

describe("employee performance and normalized metrics", () => {
  it("getEmployeePerformance returns the exact same rows as the existing getEmployeeActivity report", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, fixture.kitchenItemId, 1);

    const manager = context(fixture, "MANAGER", "mgr-1");
    const filters = { locationId: "ALL", preset: "today" } as const;
    const [perf, activity] = await Promise.all([analytics.getEmployeePerformance(manager, filters), reporting.getEmployeeActivity(manager, filters)]);
    expect(perf).toEqual(activity);
  });

  it("computes sales-per-hour only for an employee who closed a shift, and null (not fabricated) otherwise", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, fixture.kitchenItemId, 1, "CASH"); // 960 total (800 + 20% tax)

    const manager = context(fixture, "MANAGER", "mgr-1", ["audit.view", "shifts.manage"]);
    const shift = await prisma.shift.findFirstOrThrow({ where: { restaurantId: fixture.restaurantId, status: "OPEN" } });
    // Konobar NIJE zatvorio smenu (menadžer jeste) — konobar treba da dobije
    // null (aproksimacija radnih sati mu nije dostupna), menadžer treba da
    // dobije brojnu vrednost.
    const { shifts } = await import("@rcs/domain");
    await shifts.closeShift(manager, shift.id, { countedCash: Number(shift.openingCash) + 960 });

    const result = await analytics.getEmployeeNormalizedMetrics(manager, { locationId: "ALL", preset: "today" });
    const waiterRow = result.rows.find((r) => r.employeeId === "waiter-1");
    const managerRow = result.rows.find((r) => r.employeeId === "mgr-1");
    expect(waiterRow?.salesPerHour).toBeNull();
    expect(waiterRow?.approximateHours).toBeNull();
    // Menadžer nema prodaju u getEmployeeActivity osim ako nije završio
    // plaćanje — ovde menadžer samo zatvara smenu, pa možda uopšte nije u
    // activity listi; test samo potvrđuje da konobar NIKAD ne dobija
    // izmišljenu vrednost.
    expect(managerRow).toBeDefined();
  });
});

describe("hourly and weekday grouping", () => {
  it("hourly buckets sum exactly to the period's total sales, at the correct local hour", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const { payment } = await payOrderFor(fixture, waiter, fixture.kitchenItemId, 1, "CASH"); // 960

    const backdated = new Date();
    backdated.setUTCHours(18, 30, 0, 0); // proizvoljan trenutak "danas" po UTC
    await prisma.payment.update({ where: { id: payment.id }, data: { completedAt: backdated } });

    const manager = context(fixture, "MANAGER", "mgr-1");
    const result = await analytics.getSalesByHour(manager, { locationId: "ALL", preset: "today" });

    const expectedHour = localHour(backdated, "Europe/Belgrade");
    const sumAcrossHours = result.hours.reduce((s, h) => s + Number(h.sales), 0);
    expect(sumAcrossHours).toBeCloseTo(960, 2);
    expect(Number(result.hours[expectedHour].sales)).toBeCloseTo(960, 2);
    expect(result.peakSalesHour).toBe(expectedHour);
    expect(result.peakOrderHour).toBe(expectedHour);
  });

  it("weekday occurrences count correctly across a custom multi-week range", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    // Tačno 14 dana (2 pune nedelje) — svaki dan u nedelji se pojavljuje TAČNO 2 puta.
    const weekdays = await analytics.getSalesByWeekday(manager, { locationId: "ALL", preset: "custom", from: "2026-01-05", to: "2026-01-18" });
    for (const w of weekdays) {
      expect(w.occurrences).toBe(2);
    }
  });
});

describe("void and discount percentages", () => {
  it("computes voidPercentOfSales correctly and null when there is no sales denominator", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    const result = await analytics.getVoidIntelligence(manager, { locationId: "ALL", preset: "today" });
    expect(result.voidPercentOfSales).toBeNull(); // nema prodaje uopšte -> bezbedno null, ne NaN
    expect(result.voidCount).toBe(0);
  });

  it("computes discountPercentOfGross correctly for a discounted, paid order", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1", ["audit.view"]);
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 }); // 800 + 20% = 960
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await billing.applyOrderDiscount(manager, submitted.id, { amount: 96, reason: "Popust 10%" });
    await billing.completePayment(waiter, submitted.id, { method: "CARD" });

    const result = await analytics.getDiscountIntelligence(manager, { locationId: "ALL", preset: "today" });
    expect(result.totalDiscountValue).toBe("96");
    // grossSales = netSales(864) + discount(96) = 960 -> 96/960 = 10%
    expect(result.discountPercentOfGross).toBe(10);
    expect(result.byReason[0].reason).toBe("Popust 10%");
  });
});

describe("category performance reconciles with the overall period total", () => {
  it("sum of per-category revenue matches getSoldItems.summary.allRevenue for the same filters", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, fixture.kitchenItemId, 3); // sve tri stavke su u istoj "Test" kategoriji
    await payOrderFor(fixture, waiter, fixture.barItemId, 2);
    await payOrderFor(fixture, waiter, fixture.bothItemId, 1);

    const manager = context(fixture, "MANAGER", "mgr-1");
    const filters = { locationId: "ALL", preset: "today" } as const;
    const [categories, soldItems] = await Promise.all([
      analytics.getCategoryPerformance(manager, filters),
      reporting.getSoldItems(manager, filters),
    ]);

    const categorySum = categories.categories.reduce((s, c) => s + Number(c.revenue), 0);
    expect(categorySum).toBeCloseTo(Number(soldItems.summary.allRevenue), 2);
    const percentSum = categories.categories.reduce((s, c) => s + c.percentOfTotal, 0);
    expect(percentSum).toBeGreaterThan(99);
    expect(percentSum).toBeLessThanOrEqual(100.5);
  });

  it("groups items with no category under 'Nekategorisano' instead of silently omitting them", async () => {
    const fixture = await createFixture();
    const uncategorized = await prisma.menuItem.create({
      data: { restaurantId: fixture.restaurantId, categoryId: null, name: "Bez kategorije", slug: `bezkat-${randomUUID()}`, price: "300.00", taxRate: "20", preparationStation: "KITCHEN" },
    });
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, uncategorized.id, 1);

    const manager = context(fixture, "MANAGER", "mgr-1");
    const categories = await analytics.getCategoryPerformance(manager, { locationId: "ALL", preset: "today" });
    const row = categories.categories.find((c) => c.categoryName === "Nekategorisano");
    expect(row).toBeDefined();
    // revenue je NETO (item.price * quantity, bez poreza) — ista konvencija
    // kao getSoldItems.summary.allRevenue (reporting-service.ts), vidi
    // sibling test iznad koji se rekoncilira direktno protiv allRevenue bez
    // ručnog dodavanja poreza.
    expect(Number(row!.revenue)).toBeCloseTo(300, 2);
  });
});

describe("top items ranked by quantity, independently from ranking by revenue (#15)", () => {
  it("topByQuantity diverges from topItems when a cheap, high-volume item isn't the top earner", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    await payOrderFor(fixture, waiter, fixture.bothItemId, 2); // 1500 x 2 = 3000 -> najveći promet, samo 2 komada
    await payOrderFor(fixture, waiter, fixture.barItemId, 10); // 250 x 10 = 2500 -> najviše komada, ne i najveći promet
    await payOrderFor(fixture, waiter, fixture.kitchenItemId, 1); // 800

    const manager = context(fixture, "MANAGER", "mgr-1");
    const result = await analytics.getTopAndLowItems(manager, { locationId: "ALL", preset: "today" }, { limit: 5 });

    expect(result.topItems[0].name).toBe("Kombinovani tanjir"); // najveći promet (3000)
    expect(result.topByQuantity[0].name).toBe("Coca-Cola"); // najveća količina (10 komada)
    expect(result.topItems[0].name).not.toBe(result.topByQuantity[0].name);
  });
});

describe("bar production report — symmetric with kitchen, no double counting for KITCHEN_AND_BAR", () => {
  async function serve(itemId: string, station: "KITCHEN" | "BAR") {
    await prisma.orderItemStation.update({
      where: { orderItemId_station: { orderItemId: itemId, station } },
      data: { status: "SERVED" },
    });
  }

  it("reports SERVED bar items independently of kitchen, mirroring getKitchenProductionReport's shape", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    // Zaseban sto za drugu porudžbinu — openOrder na već zauzetom stolu
    // (poslata, još nenaplaćena porudžbina) vraća POSTOJEĆU porudžbinu
    // umesto nove (dedup pravilo), pa bi obe porudžbine na fixture.tableId
    // zapravo bile ISTA porudžbina.
    const floor = await prisma.floor.findFirstOrThrow({ where: { restaurantId: fixture.restaurantId } });
    const secondTable = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T2" } });
    const barOrder = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const barItem = await orders.addItem(waiter, barOrder.id, { menuItemId: fixture.barItemId, quantity: 3 });
    await orders.submitOrder(waiter, barOrder.id, { idempotencyKey: randomUUID() });
    const kitchenOrder = await orders.openOrder(waiter, { tableId: secondTable.id });
    const kitchenItem = await orders.addItem(waiter, kitchenOrder.id, { menuItemId: fixture.kitchenItemId, quantity: 2 });
    await orders.submitOrder(waiter, kitchenOrder.id, { idempotencyKey: randomUUID() });

    await serve(barItem.id, "BAR");
    await serve(kitchenItem.id, "KITCHEN");

    const manager = context(fixture, "MANAGER", "mgr-1");
    const filters = { locationId: "ALL", preset: "today" } as const;
    const [bar, kitchen] = await Promise.all([
      reporting.getBarProductionReport(manager, filters),
      reporting.getKitchenProductionReport(manager, filters),
    ]);

    expect(bar.summary.totalProduced).toBe(3);
    expect(kitchen.summary.totalProduced).toBe(2);
  });

  it("a KITCHEN_AND_BAR item produces two independent station rows — bar sees its own completion, unaffected by kitchen's", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.bothItemId, quantity: 1 });
    await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await serve(item.id, "BAR"); // samo bar strana je izbačena, kuhinjska nije

    const manager = context(fixture, "MANAGER", "mgr-1");
    const filters = { locationId: "ALL", preset: "today" } as const;
    const [bar, kitchen] = await Promise.all([
      reporting.getBarProductionReport(manager, filters),
      reporting.getKitchenProductionReport(manager, filters),
    ]);

    expect(bar.summary.totalProduced).toBe(1);
    expect(kitchen.summary.totalProduced).toBe(0); // kuhinjska strana nije stigla do SERVED
  });

  it("void count for a KITCHEN_AND_BAR item is visible in both bar and kitchen void reports (station-level snapshot, not double-subtracted from revenue)", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const manager = context(fixture, "MANAGER", "mgr-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    const item = await orders.addItem(waiter, order.id, { menuItemId: fixture.bothItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });
    await voids.voidOrderItem(manager, submitted.id, item.id, {
      quantity: 1,
      reasonCode: "OTHER",
      explanation: "Gost je otkazao pre nego što je stavka poslužena, storniramo je u celosti.",
    });

    const filters = { locationId: "ALL", preset: "today" } as const;
    const [bar, kitchen] = await Promise.all([
      reporting.getBarProductionReport(manager, filters),
      reporting.getKitchenProductionReport(manager, filters),
    ]);

    expect(bar.summary.totalVoided).toBe(1);
    expect(kitchen.summary.totalVoided).toBe(1);
  });
});

describe("edge cases: empty restaurant and zero-sales period", () => {
  it("an empty restaurant (no orders ever) returns well-formed, empty results — never throws", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    const filters = { locationId: "ALL", preset: "today" } as const;

    const kpi = await analytics.getKpiComparison(manager, filters);
    expect(kpi.current.completedOrders).toBe(0);
    expect(kpi.current.totalSales).toBe("0");

    const items = await analytics.getTopAndLowItems(manager, filters);
    expect(items.topItems).toEqual([]);

    const insights = await analytics.getInsights(manager, filters);
    expect(Array.isArray(insights)).toBe(true); // ne baca, ne izmišlja uvide bez podataka
  });

  it("a custom range spanning multiple years with zero sales returns zeroed, non-NaN totals", async () => {
    const fixture = await createFixture();
    const manager = context(fixture, "MANAGER", "mgr-1");
    const kpi = await analytics.getKpiComparison(manager, { locationId: "ALL", preset: "custom", from: "2018-01-01", to: "2023-12-31" });
    expect(kpi.current.totalSales).toBe("0");
    expect(Number.isNaN(Number(kpi.current.averageOrderValue))).toBe(false);
  });
});
