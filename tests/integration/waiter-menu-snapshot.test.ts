/**
 * P0.1a — GET /api/pos/menu/snapshot (menu.getWaiterMenuSnapshot).
 *
 * Dokazuje da novi, aditivni waiter-snapshot sloj:
 *  - vraća isključivo statički/sporo-promenljivi meni (kategorije + aktivni
 *    artikli sa cenom/porezom/dodacima), NIKAD stock/recepturisanu/
 *    operativnu dostupnost (P0.2 sloj, namerno odvojen)
 *  - poštuje restaurant/tenant i location izolaciju identično postojećem
 *    listMenuItems/listCategories obrascu (ponovo ih koristi, ne duplira)
 *  - ne menja ponašanje postojećeg /api/admin/menu/items puta
 *  - ne pravi N+1 upite ni na velikom (600+) meniju
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { menu } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  otherRestaurantId: string;
  otherLocationId: string;
}

function makeCtx(restaurantId: string, locationIds: string[], role: string, permissions: string[] = []): AuthContext {
  return {
    userId: "user-1",
    employeeId: "emp-1",
    restaurantId,
    locationIds,
    roles: [role],
    permissions: new Set(permissions),
  };
}

function waiterCtx(f: Fixture) {
  return makeCtx(f.restaurantId, [f.locationId], "WAITER", ["menu.view"]);
}
function wrongLocationCtx(f: Fixture) {
  // Isti restoran, ali zaposleni NEMA pristup traženoj lokaciji.
  return makeCtx(f.restaurantId, [f.otherLocationId], "WAITER", ["menu.view"]);
}
function otherRestaurantWaiterCtx(f: Fixture) {
  return makeCtx(f.otherRestaurantId, [f.otherLocationId], "WAITER", ["menu.view"]);
}
function noPermissionCtx(f: Fixture) {
  return makeCtx(f.restaurantId, [f.locationId], "WAITER", []);
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

describe("waiter menu snapshot: pristup i osnovni sadržaj", () => {
  it("autentifikovani konobar dobija snapshot sa kategorijama i artiklima", async () => {
    const f = await createFixture();
    const category = await prisma.menuCategory.create({
      data: { restaurantId: f.restaurantId, name: "Pića", slug: "pica", type: "DRINK", sortOrder: 0 },
    });
    await prisma.menuItem.create({
      data: { restaurantId: f.restaurantId, categoryId: category.id, name: "Rakija", slug: "rakija", price: 250, isActive: true },
    });

    const snapshot = await menu.getWaiterMenuSnapshot(waiterCtx(f), f.locationId);

    expect(snapshot.restaurantId).toBe(f.restaurantId);
    expect(snapshot.locationId).toBe(f.locationId);
    expect(snapshot.categories).toHaveLength(1);
    expect(snapshot.categories[0].name).toBe("Pića");
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].name).toBe("Rakija");
  });

  it("bez menu.view permisije baca grešku", async () => {
    const f = await createFixture();
    await expect(menu.getWaiterMenuSnapshot(noPermissionCtx(f), f.locationId)).rejects.toThrow();
  });
});

describe("waiter menu snapshot: izolacija", () => {
  it("restoran B ne vidi artikle restorana A (tenant/restaurant izolacija)", async () => {
    const f = await createFixture();
    const categoryA = await prisma.menuCategory.create({
      data: { restaurantId: f.restaurantId, name: "Hrana A", slug: "hrana-a", type: "FOOD", sortOrder: 0 },
    });
    await prisma.menuItem.create({
      data: { restaurantId: f.restaurantId, categoryId: categoryA.id, name: "Samo A", slug: "samo-a", price: 500, isActive: true },
    });

    const snapshotB = await menu.getWaiterMenuSnapshot(otherRestaurantWaiterCtx(f), f.otherLocationId);

    expect(snapshotB.items).toHaveLength(0);
    expect(snapshotB.categories).toHaveLength(0);
  });

  it("zaposleni bez pristupa traženoj lokaciji dobija ForbiddenError", async () => {
    const f = await createFixture();
    await expect(menu.getWaiterMenuSnapshot(wrongLocationCtx(f), f.locationId)).rejects.toThrow();
  });
});

describe("waiter menu snapshot: statički sadržaj tačan i potpun", () => {
  it("neaktivni i arhivirani artikli su isključeni iz snapshot-a", async () => {
    const f = await createFixture();
    const category = await prisma.menuCategory.create({
      data: { restaurantId: f.restaurantId, name: "Hrana", slug: "hrana", type: "FOOD", sortOrder: 0 },
    });
    await prisma.menuItem.create({
      data: { restaurantId: f.restaurantId, categoryId: category.id, name: "Aktivan", slug: "aktivan", price: 100, isActive: true },
    });
    await prisma.menuItem.create({
      data: { restaurantId: f.restaurantId, categoryId: category.id, name: "Neaktivan", slug: "neaktivan", price: 100, isActive: false },
    });
    await prisma.menuItem.create({
      data: { restaurantId: f.restaurantId, categoryId: category.id, name: "Arhiviran", slug: "arhiviran", price: 100, isActive: false, deletedAt: new Date() },
    });

    const snapshot = await menu.getWaiterMenuSnapshot(waiterCtx(f), f.locationId);

    expect(snapshot.items.map((i) => i.name)).toEqual(["Aktivan"]);
  });

  it("dodaci (modifier grupe/opcije) su ispravno vezani za artikal", async () => {
    const f = await createFixture();
    const category = await prisma.menuCategory.create({
      data: { restaurantId: f.restaurantId, name: "Pića", slug: "pica-mod", type: "DRINK", sortOrder: 0 },
    });
    const item = await prisma.menuItem.create({
      data: { restaurantId: f.restaurantId, categoryId: category.id, name: "Kafa", slug: "kafa", price: 150, isActive: true },
    });
    const group = await prisma.modifierGroup.create({
      data: { restaurantId: f.restaurantId, name: "Mleko", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0 },
    });
    await prisma.modifierOption.create({ data: { modifierGroupId: group.id, name: "Bez mleka", priceDelta: 0, sortOrder: 0 } });
    await prisma.modifierOption.create({ data: { modifierGroupId: group.id, name: "Sa mlekom", priceDelta: 20, sortOrder: 1 } });
    await prisma.menuItemModifierGroup.create({ data: { menuItemId: item.id, modifierGroupId: group.id, sortOrder: 0 } });

    const snapshot = await menu.getWaiterMenuSnapshot(waiterCtx(f), f.locationId);

    const kafa = snapshot.items.find((i) => i.name === "Kafa");
    expect(kafa?.modifierGroups).toHaveLength(1);
    const options = kafa!.modifierGroups[0].group.options.map((o) => o.name).sort();
    expect(options).toEqual(["Bez mleka", "Sa mlekom"]);
  });

  it("cena/porez/statička polja se poklapaju sa autoritativnim menu podacima", async () => {
    const f = await createFixture();
    const category = await prisma.menuCategory.create({
      data: { restaurantId: f.restaurantId, name: "Hrana", slug: "hrana-cena", type: "FOOD", sortOrder: 0 },
    });
    const created = await prisma.menuItem.create({
      data: { restaurantId: f.restaurantId, categoryId: category.id, name: "Pljeskavica", slug: "pljeskavica", price: 890, taxRate: 20, preparationStation: "KITCHEN", isActive: true },
    });

    const snapshot = await menu.getWaiterMenuSnapshot(waiterCtx(f), f.locationId);
    const item = snapshot.items.find((i) => i.id === created.id)!;

    expect(Number(item.price)).toBe(890);
    expect(Number(item.taxRate)).toBe(20);
    expect(item.preparationStation).toBe("KITCHEN");
    expect(item.categoryId).toBe(category.id);
  });
});

describe("waiter menu snapshot: NIKAD live podaci", () => {
  it("blokirana dostupnost na lokaciji ne utiče na snapshot i live polja nikad ne postoje", async () => {
    const f = await createFixture();
    const category = await prisma.menuCategory.create({
      data: { restaurantId: f.restaurantId, name: "Hrana", slug: "hrana-live", type: "FOOD", sortOrder: 0 },
    });
    const item = await prisma.menuItem.create({
      data: { restaurantId: f.restaurantId, categoryId: category.id, name: "Riba", slug: "riba", price: 1200, isActive: true },
    });
    // Eksplicitno blokirana operativna dostupnost za ovu lokaciju — ako bi
    // snapshot ikad pozvao live overlay, ovo bi se odrazilo na item.
    await prisma.menuItemAvailability.create({
      data: { restaurantId: f.restaurantId, locationId: f.locationId, menuItemId: item.id, isAvailable: false, updatedBy: "emp-1" },
    });

    const snapshot = await menu.getWaiterMenuSnapshot(waiterCtx(f), f.locationId);
    const riba = snapshot.items.find((i) => i.id === item.id);

    // Artikal i dalje postoji u statičkom snapshot-u (blok je live/operativni
    // podatak, ne utiče na to da li artikal uopšte postoji u meniju)...
    expect(riba).toBeDefined();
    // ...ali NIJEDNO live polje nije prisutno — dokaz da nijedan
    // stock/recepturisani/operativni proračun nije izvršen.
    expect((riba as Record<string, unknown>).stock).toBeUndefined();
    expect((riba as Record<string, unknown>).recipeAvailability).toBeUndefined();
    expect((riba as Record<string, unknown>).availability).toBeUndefined();
  });
});

describe("waiter menu snapshot: performanse na velikom meniju", () => {
  it("600 artikala ne izaziva N+1 (snapshot i dalje brz, sve stavke prisutne)", async () => {
    const f = await createFixture();
    const category = await prisma.menuCategory.create({
      data: { restaurantId: f.restaurantId, name: "Veliki meni", slug: "veliki-meni", type: "FOOD", sortOrder: 0 },
    });
    const ITEM_COUNT = 600;
    await prisma.menuItem.createMany({
      data: Array.from({ length: ITEM_COUNT }, (_, i) => ({
        restaurantId: f.restaurantId,
        categoryId: category.id,
        name: `Artikal ${i}`,
        slug: `artikal-${i}`,
        price: 100 + i,
        isActive: true,
      })),
    });

    const started = Date.now();
    const snapshot = await menu.getWaiterMenuSnapshot(waiterCtx(f), f.locationId);
    const elapsedMs = Date.now() - started;

    expect(snapshot.items).toHaveLength(ITEM_COUNT);
    // N+1 na 600 artikala (jedan upit po artiklu/modifikatoru) bi na realnoj
    // mrežnoj Postgres konekciji trajalo desetine sekundi; ova granica je
    // namerno velikodušna (ne testira apsolutnu brzinu) ali dovoljno strogo
    // razlikuje "par batch upita" od "upit po redu".
    expect(elapsedMs).toBeLessThan(8000);
  });
});

describe("waiter menu snapshot: ne menja postojeće ponašanje", () => {
  it("postojeći listMenuItems (admin/order put) ostaje nepromenjen i i dalje vraća live polja", async () => {
    const f = await createFixture();
    const category = await prisma.menuCategory.create({
      data: { restaurantId: f.restaurantId, name: "Hrana", slug: "hrana-nepromenjen", type: "FOOD", sortOrder: 0 },
    });
    await prisma.menuItem.create({
      data: { restaurantId: f.restaurantId, categoryId: category.id, name: "Ćevapi", slug: "cevapi", price: 700, isActive: true },
    });

    const ctx = waiterCtx(f);
    const snapshot = await menu.getWaiterMenuSnapshot(ctx, f.locationId);
    const existingPath = await menu.listMenuItems(ctx, { activeOnly: true, locationId: f.locationId });

    expect(snapshot.items).toHaveLength(1);
    expect(existingPath).toHaveLength(1);
    // Isti bazni artikal...
    expect(existingPath[0].id).toBe(snapshot.items[0].id);
    // ...ali SAMO postojeći put nosi live overlay polja — dokaz da P0.1a
    // ništa nije promenio u postojećem ponašanju.
    expect(existingPath[0]).toHaveProperty("availability");
    expect((snapshot.items[0] as Record<string, unknown>).availability).toBeUndefined();
  });
});
