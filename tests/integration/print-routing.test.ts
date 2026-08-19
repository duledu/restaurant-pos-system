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
  bothItemId: string;
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
  const tenant = await prisma.tenant.create({ data: { name: "Print tenant", slug: `print-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const floor = await prisma.floor.create({ data: { restaurantId: restaurant.id, locationId: location.id, name: "Floor" } });
  const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "T5" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "manager" } });

  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Test", slug: `test-${randomUUID()}`, type: "FOOD" },
  });
  const kitchenItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Pljeskavica",
      slug: `pljeskavica-${randomUUID()}`,
      price: "800.00",
      taxRate: "20",
      preparationStation: "KITCHEN",
    },
  });
  const barItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Coca-Cola",
      slug: `cola-${randomUUID()}`,
      price: "250.00",
      taxRate: "20",
      preparationStation: "BAR",
    },
  });
  const bothItem = await prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: "Kombinovani tanjir",
      slug: `combo-${randomUUID()}`,
      price: "1500.00",
      taxRate: "20",
      preparationStation: "KITCHEN_AND_BAR",
    },
  });

  return {
    restaurantId: restaurant.id,
    locationId: location.id,
    tableId: table.id,
    kitchenItemId: kitchenItem.id,
    barItemId: barItem.id,
    bothItemId: bothItem.id,
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});


describe("print routing: kitchen/bar tickets follow OrderItemStation, never a second routing system", () => {
  it("dispatches a KITCHEN print job containing only kitchen items, with modifiers/notes, and no prices", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 2, note: "bez luka" });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.barItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJob = jobs.find((j) => j.type === "KITCHEN");
    expect(kitchenJob).toBeTruthy();
    const content = kitchenJob!.content as { items: { name: string; quantity: number; note: string | null }[] };
    expect(content.items).toHaveLength(1);
    expect(content.items[0]).toMatchObject({ name: "Pljeskavica", quantity: 2, note: "bez luka" });
    // Priprema NIKAD ne prikazuje cenu — proveri da cifra cene nije nigde u sadržaju.
    expect(JSON.stringify(content)).not.toContain("800");
  });

  it("dispatches a BAR print job containing only bar items, never kitchen items", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.kitchenItemId, quantity: 1 });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.barItemId, quantity: 3 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const barJob = jobs.find((j) => j.type === "BAR");
    expect(barJob).toBeTruthy();
    const content = barJob!.content as { items: { name: string; quantity: number }[] };
    expect(content.items).toHaveLength(1);
    expect(content.items[0]).toMatchObject({ name: "Coca-Cola", quantity: 3 });
    expect(content.items.some((i) => i.name === "Pljeskavica")).toBe(false);
    expect(JSON.stringify(content)).not.toContain("250");
  });

  it("KITCHEN_AND_BAR item produces exactly one KITCHEN job and one BAR job, each with the item", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.bothItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    const kitchenJobs = jobs.filter((j) => j.type === "KITCHEN");
    const barJobs = jobs.filter((j) => j.type === "BAR");
    expect(kitchenJobs).toHaveLength(1);
    expect(barJobs).toHaveLength(1);

    const kContent = kitchenJobs[0].content as { items: { name: string }[] };
    const bContent = barJobs[0].content as { items: { name: string }[] };
    expect(kContent.items[0].name).toBe("Kombinovani tanjir");
    expect(bContent.items[0].name).toBe("Kombinovani tanjir");
  });

  it("an order with only bar items never creates a KITCHEN job at all", async () => {
    const fixture = await createFixture();
    const waiter = context(fixture, "WAITER", "waiter-1");
    const order = await orders.openOrder(waiter, { tableId: fixture.tableId });
    await orders.addItem(waiter, order.id, { menuItemId: fixture.barItemId, quantity: 1 });
    const submitted = await orders.submitOrder(waiter, order.id, { idempotencyKey: randomUUID() });

    const jobs = await printing.listPrintJobs(waiter, submitted.id);
    expect(jobs.filter((j) => j.type === "KITCHEN")).toHaveLength(0);
    expect(jobs.filter((j) => j.type === "BAR")).toHaveLength(1);
  });
});
