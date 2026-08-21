/**
 * Integracioni testovi za upravljanje salama i stolovima.
 *
 * Pokriva:
 * - Kreiranje sale (Floor)
 * - Preimenovanje sale
 * - Kreiranje stola (RestaurantTable)
 * - Izmena stola (naziv, kapacitet, premeštanje u drugu salu)
 * - Deaktivacija stola (sa proverom aktivne porudžbine)
 * - Aktivacija stola
 * - Vidljivost konobarima (listTables vraca samo aktivne)
 * - Izolacija restorana
 * - Izolacija lokacije
 * - Zabrana za WAITER/KITCHEN/BAR
 * - Istorija porudžbina ostaje sačuvana posle deaktivacije
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { tables, orders, shifts } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  otherRestaurantId: string;
  otherLocationId: string;
}

function makeCtx(
  restaurantId: string,
  locationIds: string[],
  role: string,
  permissions: string[] = []
): AuthContext {
  return {
    userId: "user-1",
    employeeId: "emp-1",
    restaurantId,
    locationIds,
    roles: [role],
    permissions: new Set(permissions),
  };
}

function ownerCtx(f: Fixture) {
  return makeCtx(f.restaurantId, [f.locationId], "OWNER", [
    "settings.manage", "orders.create", "orders.submit", "orders.manage", "shifts.manage", "menu.view",
  ]);
}
function waiterCtx(f: Fixture) {
  return makeCtx(f.restaurantId, [f.locationId], "WAITER", ["menu.view", "orders.create", "orders.submit"]);
}
function kitchenCtx(f: Fixture) {
  return makeCtx(f.restaurantId, [f.locationId], "KITCHEN", ["menu.view"]);
}
function otherRestaurantCtx(f: Fixture) {
  return makeCtx(f.otherRestaurantId, [f.otherLocationId], "OWNER", ["settings.manage"]);
}
function locationBCtx(f: Fixture) {
  return makeCtx(f.restaurantId, [f.otherLocationId], "OWNER", ["settings.manage"]);
}

async function createFixture(): Promise<Fixture> {
  const tenantA = await prisma.tenant.create({ data: { name: "Tenant A", slug: `ta-${randomUUID()}` } });
  const restaurantA = await prisma.restaurant.create({ data: { tenantId: tenantA.id, name: "Restoran A", currency: "RSD" } });
  const locationA = await prisma.location.create({ data: { restaurantId: restaurantA.id, name: "Lokacija A" } });

  const tenantB = await prisma.tenant.create({ data: { name: "Tenant B", slug: `tb-${randomUUID()}` } });
  const restaurantB = await prisma.restaurant.create({ data: { tenantId: tenantB.id, name: "Restoran B", currency: "RSD" } });
  const locationB = await prisma.location.create({ data: { restaurantId: restaurantB.id, name: "Lokacija B" } });

  return {
    restaurantId: restaurantA.id,
    locationId: locationA.id,
    otherRestaurantId: restaurantB.id,
    otherLocationId: locationB.id,
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("floor: kreiranje i preimenovanje", () => {
  it("OWNER moze kreirati salu za svoju lokaciju", async () => {
    const f = await createFixture();
    const floor = await tables.createFloor(ownerCtx(f), { locationId: f.locationId, name: "Glavna sala" });
    expect(floor.name).toBe("Glavna sala");
    expect(floor.restaurantId).toBe(f.restaurantId);
    expect(floor.locationId).toBe(f.locationId);
  });

  it("kreiranje sale postuje redosled (sortOrder inkrementiran)", async () => {
    const f = await createFixture();
    const ctx = ownerCtx(f);
    const s1 = await tables.createFloor(ctx, { locationId: f.locationId, name: "Sala 1" });
    const s2 = await tables.createFloor(ctx, { locationId: f.locationId, name: "Sala 2" });
    expect(s2.sortOrder).toBeGreaterThan(s1.sortOrder);
  });

  it("WAITER ne moze kreirati salu", async () => {
    const f = await createFixture();
    await expect(
      tables.createFloor(waiterCtx(f), { locationId: f.locationId, name: "Sala" })
    ).rejects.toThrow();
  });

  it("KITCHEN ne moze kreirati salu", async () => {
    const f = await createFixture();
    await expect(
      tables.createFloor(kitchenCtx(f), { locationId: f.locationId, name: "Sala" })
    ).rejects.toThrow();
  });

  it("kreiranje sale za tudu lokaciju je odbijeno", async () => {
    const f = await createFixture();
    await expect(
      tables.createFloor(locationBCtx(f), { locationId: f.locationId, name: "Sala" })
    ).rejects.toThrow();
  });

  it("OWNER moze preimenovati salu", async () => {
    const f = await createFixture();
    const ctx = ownerCtx(f);
    const floor = await tables.createFloor(ctx, { locationId: f.locationId, name: "Staro ime" });
    const updated = await tables.updateFloor(ctx, floor.id, { name: "Novo ime" });
    expect(updated.name).toBe("Novo ime");
  });

  it("preimenovanje sale drugog restorana je odbijeno", async () => {
    const f = await createFixture();
    const floor = await tables.createFloor(ownerCtx(f), { locationId: f.locationId, name: "Sala A" });
    await expect(
      tables.updateFloor(otherRestaurantCtx(f), floor.id, { name: "Hakovan naziv" })
    ).rejects.toThrow("Sala nije pronađena");
  });
});

describe("table: kreiranje i izmena", () => {
  async function createFloor(f: Fixture) {
    return tables.createFloor(ownerCtx(f), { locationId: f.locationId, name: "Test sala" });
  }

  it("OWNER moze kreirati sto u sali", async () => {
    const f = await createFixture();
    const floor = await createFloor(f);
    const table = await tables.createTable(ownerCtx(f), { floorId: floor.id, label: "Sto 1", capacity: 4 });
    expect(table.label).toBe("Sto 1");
    expect(table.capacity).toBe(4);
    expect(table.isActive).toBe(true);
  });

  it("dupli naziv stola u istoj sali je odbijen", async () => {
    const f = await createFixture();
    const floor = await createFloor(f);
    const ctx = ownerCtx(f);
    await tables.createTable(ctx, { floorId: floor.id, label: "Sto 1", capacity: 4 });
    await expect(
      tables.createTable(ctx, { floorId: floor.id, label: "Sto 1", capacity: 2 })
    ).rejects.toThrow('Sto "Sto 1" već postoji u ovoj sali');
  });

  it("isti naziv stola u razlicitim salama je dozvoljen", async () => {
    const f = await createFixture();
    const ctx = ownerCtx(f);
    const floor1 = await tables.createFloor(ctx, { locationId: f.locationId, name: "Sala 1" });
    const floor2 = await tables.createFloor(ctx, { locationId: f.locationId, name: "Sala 2" });
    const t1 = await tables.createTable(ctx, { floorId: floor1.id, label: "Sto 1" });
    const t2 = await tables.createTable(ctx, { floorId: floor2.id, label: "Sto 1" });
    expect(t1.id).not.toBe(t2.id);
  });

  it("WAITER ne moze kreirati sto", async () => {
    const f = await createFixture();
    const floor = await createFloor(f);
    await expect(
      tables.createTable(waiterCtx(f), { floorId: floor.id, label: "Sto 1" })
    ).rejects.toThrow();
  });

  it("kreiranje stola za salu drugog restorana je odbijeno", async () => {
    const f = await createFixture();
    const floor = await createFloor(f);
    await expect(
      tables.createTable(otherRestaurantCtx(f), { floorId: floor.id, label: "Sto 1" })
    ).rejects.toThrow("Sala nije pronađena");
  });

  it("OWNER moze izmeniti naziv i kapacitet stola", async () => {
    const f = await createFixture();
    const floor = await createFloor(f);
    const ctx = ownerCtx(f);
    const table = await tables.createTable(ctx, { floorId: floor.id, label: "Sto 1", capacity: 2 });
    const updated = await tables.updateTable(ctx, table.id, { label: "VIP 1", capacity: 8 });
    expect(updated.label).toBe("VIP 1");
    expect(updated.capacity).toBe(8);
  });

  it("sto se moze premestiti u drugu salu bez brisanja", async () => {
    const f = await createFixture();
    const ctx = ownerCtx(f);
    const floor1 = await tables.createFloor(ctx, { locationId: f.locationId, name: "Sala 1" });
    const floor2 = await tables.createFloor(ctx, { locationId: f.locationId, name: "Sala 2" });
    const table = await tables.createTable(ctx, { floorId: floor1.id, label: "Sto 1" });
    const moved = await tables.updateTable(ctx, table.id, { floorId: floor2.id });
    expect(moved.floorId).toBe(floor2.id);

    // record still exists in DB
    const found = await prisma.restaurantTable.findUnique({ where: { id: table.id } });
    expect(found).not.toBeNull();
  });
});

describe("table: deaktivacija i aktivacija", () => {
  async function setup() {
    const f = await createFixture();
    const ctx = ownerCtx(f);
    const floor = await tables.createFloor(ctx, { locationId: f.locationId, name: "Test sala" });
    const table = await tables.createTable(ctx, { floorId: floor.id, label: "Sto 99" });
    return { f, ctx, floor, table };
  }

  it("deaktiviran sto ne prikazuje se konobarima", async () => {
    const { f, ctx, table } = await setup();
    await tables.deactivateTable(ctx, table.id);

    const floors = await tables.listTables(ctx, f.locationId);
    const allTables = floors.flatMap((fl) => fl.tables);
    expect(allTables.find((t) => t.id === table.id)).toBeUndefined();
  });

  it("aktivan sto prikazuje se konobarima", async () => {
    const { f, ctx, table } = await setup();
    const floors = await tables.listTables(ctx, f.locationId);
    const allTables = floors.flatMap((fl) => fl.tables);
    expect(allTables.find((t) => t.id === table.id)).toBeDefined();
  });

  it("reaktivirani sto ponovo se prikazuje konobarima", async () => {
    const { f, ctx, table } = await setup();
    await tables.deactivateTable(ctx, table.id);
    await tables.activateTable(ctx, table.id);

    const floors = await tables.listTables(ctx, f.locationId);
    const allTables = floors.flatMap((fl) => fl.tables);
    expect(allTables.find((t) => t.id === table.id)).toBeDefined();
  });

  it("adminListFloors prikazuje i neaktivne stolove", async () => {
    const { f, ctx, table } = await setup();
    await tables.deactivateTable(ctx, table.id);

    const floors = await tables.adminListFloors(ctx, f.locationId);
    const allTables = floors.flatMap((fl) => fl.tables);
    const found = allTables.find((t) => t.id === table.id);
    expect(found).toBeDefined();
    expect(found?.isActive).toBe(false);
  });

  it("deaktivacija stola sa aktivnom porudzbinom je odbijena", async () => {
    const { f, ctx, floor, table } = await setup();

    // Create shift and active order on the table
    await prisma.shift.create({
      data: { restaurantId: f.restaurantId, locationId: f.locationId, openedBy: "emp-1" },
    });
    const category = await prisma.menuCategory.create({
      data: { restaurantId: f.restaurantId, name: "Pice", slug: `pice-${randomUUID()}`, type: "DRINK" },
    });
    await prisma.menuItem.create({
      data: { restaurantId: f.restaurantId, categoryId: category.id, name: "Kafa", slug: `kafa-${randomUUID()}`, price: "150", taxRate: "20", preparationStation: "BAR" },
    });

    // Open an order on the table directly via Prisma (tests order-with-active-table safety)
    const shift = await prisma.shift.findFirst({ where: { restaurantId: f.restaurantId } });
    await prisma.order.create({
      data: {
        restaurantId: f.restaurantId,
        locationId: f.locationId,
        tableId: table.id,
        shiftId: shift!.id,
        openedBy: "emp-1",
        status: "SUBMITTED",
      },
    });

    await expect(
      tables.deactivateTable(ctx, table.id)
    ).rejects.toThrow("aktivnu porudžbinu");
  });

  it("sto ostaje u bazi posle deaktivacije (istorija porudzbina sacuvana)", async () => {
    const { ctx, table } = await setup();
    await tables.deactivateTable(ctx, table.id);

    const found = await prisma.restaurantTable.findUnique({ where: { id: table.id } });
    expect(found).not.toBeNull();
    expect(found?.isActive).toBe(false);
  });

  it("deaktiviran sto nije dostupan konobaru za otvaranje porudzbine", async () => {
    const { f, ctx, table } = await setup();
    await tables.deactivateTable(ctx, table.id);

    await expect(
      tables.getTable(waiterCtx(f), table.id)
    ).rejects.toThrow("nije aktivan");
  });

  it("WAITER ne moze deaktivirati sto", async () => {
    const { f, table } = await setup();
    await expect(
      tables.deactivateTable(waiterCtx(f), table.id)
    ).rejects.toThrow();
  });

  it("deaktivacija stola drugog restorana je odbijena", async () => {
    const { f, table } = await setup();
    await expect(
      tables.deactivateTable(otherRestaurantCtx(f), table.id)
    ).rejects.toThrow("Sto nije pronađen");
  });
});

describe("restaurant i location izolacija", () => {
  it("adminListFloors za tudu lokaciju je odbijena", async () => {
    const f = await createFixture();
    await expect(
      tables.adminListFloors(locationBCtx(f), f.locationId)
    ).rejects.toThrow();
  });

  it("listTables za tudu lokaciju je odbijena", async () => {
    const f = await createFixture();
    await expect(
      tables.listTables(locationBCtx(f), f.locationId)
    ).rejects.toThrow();
  });

  it("kreiranje stola u sali drugog restorana je odbijeno", async () => {
    const f = await createFixture();
    const floor = await tables.createFloor(ownerCtx(f), { locationId: f.locationId, name: "Sala A" });
    await expect(
      tables.createTable(otherRestaurantCtx(f), { floorId: floor.id, label: "Sto 1" })
    ).rejects.toThrow("Sala nije pronađena");
  });
});

describe("waiter vidljivost novih stolova", () => {
  it("novokreiran sto odmah vidljiv u listTables (bez DB popravke)", async () => {
    const f = await createFixture();
    const ctx = ownerCtx(f);

    const floor = await tables.createFloor(ctx, { locationId: f.locationId, name: "Nova sala" });
    await tables.createTable(ctx, { floorId: floor.id, label: "Sto 99", capacity: 6 });

    const floors = await tables.listTables(ctx, f.locationId);
    const allLabels = floors.flatMap((fl) => fl.tables.map((t) => t.label));
    expect(allLabels).toContain("Sto 99");
  });
});
