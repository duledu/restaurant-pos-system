/**
 * P0.2a — puni matriks mutacija koje MORAJU (ili NE SMEJU) da bumpuju
 * menuVersion. Realan Postgres (TEST_DATABASE_URL, kao i svaki integration
 * test) + mock-ovan @upstash/redis (realan in-memory dvojnik, isti obrazac
 * kao tests/unit/menu-version.test.ts) — ovde nam treba STVARAN, čitljiv
 * broj verzije posle svake mutacije, ne samo "da li je funkcija pozvana".
 *
 * KRITIČNA RAZLIKA koju ovaj fajl dokazuje: menu.setAvailability (statičko
 * MenuItem.isAvailable, restoran-široko polje, deo P0.1a snapshot-a) MORA
 * bumpovati; availability.setAvailability (MenuItemAvailability, LIVE
 * po-lokacijska operativna blokada, POTPUNO odvojena tabela/fajl) NIKAD ne
 * sme bumpovati — iste ime funkcije, različiti moduli, različita semantika.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { menu, modifiers, availability as liveAvailability } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface SetOptions {
  nx?: boolean;
  get?: boolean;
  ex?: number;
}

/** Realan in-memory Redis dvojnik — ISPRAVNO implementira SET key val NX GET
 * (vidi tests/unit/menu-version.test.ts za punu napomenu zašto ovo mora biti
 * tačno, ne samo "vrati OK"). */
function createFakeRedis() {
  const store = new Map<string, number>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: number, opts?: SetOptions) => {
      const hadKey = store.has(key);
      const oldValue = hadKey ? (store.get(key) ?? null) : null;
      if (opts?.nx && hadKey) return opts?.get ? oldValue : null;
      store.set(key, value);
      return opts?.get ? oldValue : "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    }),
    incr: vi.fn(async (key: string) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
  };
}

let fakeRedis = createFakeRedis();

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn().mockImplementation(() => fakeRedis),
}));

beforeEach(() => {
  fakeRedis = createFakeRedis();
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  categoryId: string;
  itemId: string;
}

function makeCtx(restaurantId: string, locationIds: string[], role: string, permissions: string[]): AuthContext {
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
  return makeCtx(f.restaurantId, [f.locationId], "OWNER", ["menu.view", "menu.manage", "production.manage"]);
}
function waiterCtx(f: Fixture) {
  return makeCtx(f.restaurantId, [f.locationId], "WAITER", ["menu.view"]); // NEMA menu.manage — mutacije moraju pasti
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "T", slug: `t-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "R", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "R2", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Loc" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Hrana", slug: `hrana-${randomUUID()}`, type: "FOOD", sortOrder: 0 },
  });
  const item = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, price: 500, isActive: true },
  });
  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id, categoryId: category.id, itemId: item.id };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

async function version(restaurantId: string): Promise<number> {
  return menu.getMenuVersion(restaurantId);
}

describe("P0.2a mutation coverage matrix: CATEGORIES", () => {
  it("createCategory bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.createCategory(ownerCtx(f), { name: "Pića", slug: `pica-${randomUUID()}`, type: "DRINK", sortOrder: 1 });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("updateCategory bumps exactly once (not double via invalidateMenuSnapshotCache)", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.updateCategory(ownerCtx(f), f.categoryId, { name: "Hrana (izmenjeno)" });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("reorderCategories bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.reorderCategories(ownerCtx(f), { orderedIds: [f.categoryId] });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("deleteCategory bumps exactly once", async () => {
    const f = await createFixture();
    const empty = await prisma.menuCategory.create({
      data: { restaurantId: f.restaurantId, name: "Prazna", slug: `prazna-${randomUUID()}`, type: "FOOD", sortOrder: 5 },
    });
    const before = await version(f.restaurantId);
    await menu.deleteCategory(ownerCtx(f), empty.id, false);
    expect(await version(f.restaurantId)).toBe(before + 1);
  });
});

describe("P0.2a mutation coverage matrix: MENU ITEMS", () => {
  it("createMenuItem bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.createMenuItem(ownerCtx(f), { name: "Novo", slug: `novo-${randomUUID()}`, price: 300, taxRate: 20, sortOrder: 0, isActive: true, isAvailable: true, preparationStation: "NONE", needsReview: false });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("updateMenuItem bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.updateMenuItem(ownerCtx(f), f.itemId, { name: "Pljeskavica (nova)" });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("changePrice bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.changePrice(ownerCtx(f), f.itemId, { price: 650 });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("moveToCategory bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.moveToCategory(ownerCtx(f), f.itemId, { categoryId: null });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("menu.setAvailability (STATIC MenuItem.isAvailable) bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.setAvailability(ownerCtx(f), f.itemId, false);
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("setActive bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.setActive(ownerCtx(f), f.itemId, false);
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("archiveMenuItem bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.archiveMenuItem(ownerCtx(f), f.itemId);
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("deleteMenuItem bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.deleteMenuItem(ownerCtx(f), f.itemId);
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("duplicateMenuItem bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await menu.duplicateMenuItem(ownerCtx(f), f.itemId);
    expect(await version(f.restaurantId)).toBe(before + 1);
  });
});

describe("P0.2a mutation coverage matrix: MODIFIERS (previously ZERO cache invalidation — closed here)", () => {
  it("createModifierGroup bumps", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await modifiers.createModifierGroup(ownerCtx(f), { name: "Veličina", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("updateModifierGroup bumps", async () => {
    const f = await createFixture();
    const group = await modifiers.createModifierGroup(ownerCtx(f), { name: "Veličina", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    const before = await version(f.restaurantId);
    await modifiers.updateModifierGroup(ownerCtx(f), group.id, { name: "Veličina (nova)" });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("setModifierGroupActive bumps", async () => {
    const f = await createFixture();
    const group = await modifiers.createModifierGroup(ownerCtx(f), { name: "Veličina", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    const before = await version(f.restaurantId);
    await modifiers.setModifierGroupActive(ownerCtx(f), group.id, false);
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("createModifierOption bumps", async () => {
    const f = await createFixture();
    const group = await modifiers.createModifierGroup(ownerCtx(f), { name: "Veličina", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    const before = await version(f.restaurantId);
    await modifiers.createModifierOption(ownerCtx(f), group.id, { name: "Malo", priceDelta: 0, sortOrder: 0, isActive: true });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("updateModifierOption (price change) bumps", async () => {
    const f = await createFixture();
    const group = await modifiers.createModifierGroup(ownerCtx(f), { name: "Veličina", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    const option = await modifiers.createModifierOption(ownerCtx(f), group.id, { name: "Malo", priceDelta: 0, sortOrder: 0, isActive: true });
    const before = await version(f.restaurantId);
    await modifiers.updateModifierOption(ownerCtx(f), option.id, { priceDelta: 50 });
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("setModifierOptionActive bumps", async () => {
    const f = await createFixture();
    const group = await modifiers.createModifierGroup(ownerCtx(f), { name: "Veličina", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    const option = await modifiers.createModifierOption(ownerCtx(f), group.id, { name: "Malo", priceDelta: 0, sortOrder: 0, isActive: true });
    const before = await version(f.restaurantId);
    await modifiers.setModifierOptionActive(ownerCtx(f), option.id, false);
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("attachModifierGroupToItem bumps", async () => {
    const f = await createFixture();
    const group = await modifiers.createModifierGroup(ownerCtx(f), { name: "Veličina", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    const before = await version(f.restaurantId);
    await modifiers.attachModifierGroupToItem(ownerCtx(f), f.itemId, group.id);
    expect(await version(f.restaurantId)).toBe(before + 1);
  });

  it("attaching an ALREADY-attached group is idempotent and does NOT bump again", async () => {
    const f = await createFixture();
    const group = await modifiers.createModifierGroup(ownerCtx(f), { name: "Veličina", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    await modifiers.attachModifierGroupToItem(ownerCtx(f), f.itemId, group.id);
    const before = await version(f.restaurantId);
    await modifiers.attachModifierGroupToItem(ownerCtx(f), f.itemId, group.id); // isti poziv opet
    expect(await version(f.restaurantId)).toBe(before); // NEMA promene — ništa se stvarno nije izmenilo
  });

  it("detachModifierGroupFromItem bumps", async () => {
    const f = await createFixture();
    const group = await modifiers.createModifierGroup(ownerCtx(f), { name: "Veličina", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    await modifiers.attachModifierGroupToItem(ownerCtx(f), f.itemId, group.id);
    const before = await version(f.restaurantId);
    await modifiers.detachModifierGroupFromItem(ownerCtx(f), f.itemId, group.id);
    expect(await version(f.restaurantId)).toBe(before + 1);
  });
});

describe("P0.2a: LIVE operational state must NEVER bump the static menu version", () => {
  it("availability.setAvailability (MenuItemAvailability, per-location LIVE block) does NOT bump — distinct from menu.setAvailability", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await liveAvailability.setAvailability(ownerCtx(f), {
      locationId: f.locationId,
      menuItemId: f.itemId,
      isAvailable: false,
      reasonCode: "DRUGO",
    });
    expect(await version(f.restaurantId)).toBe(before); // NEMA promene
  });
});

describe("P0.2a: failed mutation must NEVER produce a successful version bump", () => {
  it("a WAITER (no menu.manage) attempting createMenuItem fails and does NOT bump", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await expect(
      menu.createMenuItem(waiterCtx(f), { name: "X", slug: `x-${randomUUID()}`, price: 100, taxRate: 20, sortOrder: 0, isActive: true, isAvailable: true, preparationStation: "NONE", needsReview: false })
    ).rejects.toThrow();
    expect(await version(f.restaurantId)).toBe(before);
  });

  it("changePrice on a nonexistent item fails and does NOT bump", async () => {
    const f = await createFixture();
    const before = await version(f.restaurantId);
    await expect(menu.changePrice(ownerCtx(f), randomUUID(), { price: 999 })).rejects.toThrow();
    expect(await version(f.restaurantId)).toBe(before);
  });

  it("attachModifierGroupToItem for a nonexistent item fails and does NOT bump", async () => {
    const f = await createFixture();
    const group = await modifiers.createModifierGroup(ownerCtx(f), { name: "Veličina", required: false, minSelect: 0, maxSelect: 1, sortOrder: 0, isActive: true });
    const before = await version(f.restaurantId);
    await expect(modifiers.attachModifierGroupToItem(ownerCtx(f), randomUUID(), group.id)).rejects.toThrow();
    expect(await version(f.restaurantId)).toBe(before);
  });
});

describe("P0.2a: restaurant isolation", () => {
  it("mutating restaurant A's menu never bumps restaurant B's version", async () => {
    const f = await createFixture();
    const beforeA = await version(f.restaurantId);
    const beforeB = await version(f.otherRestaurantId);
    await menu.changePrice(ownerCtx(f), f.itemId, { price: 777 });
    expect(await version(f.restaurantId)).toBe(beforeA + 1);
    expect(await version(f.otherRestaurantId)).toBe(beforeB);
  });
});

describe("P0.2a: existing cache invalidation behavior still works (unchanged)", () => {
  it("updateMenuItem still invalidates the Redis menu-items cache — a subsequent listMenuItems reflects the change immediately", async () => {
    const f = await createFixture();
    const ctx = ownerCtx(f);

    // Zagrej keš (isti obrazac kao P0.1a testovi).
    const before = await menu.listMenuItems(ctx, { activeOnly: true });
    expect(before.find((i) => i.id === f.itemId)?.name).toBe("Pljeskavica");

    await menu.updateMenuItem(ctx, f.itemId, { name: "Pljeskavica Extra" });

    const after = await menu.listMenuItems(ctx, { activeOnly: true });
    expect(after.find((i) => i.id === f.itemId)?.name).toBe("Pljeskavica Extra");
  });
});

describe("P0.2a: P0.1a waiter snapshot behavior remains unchanged", () => {
  it("getWaiterMenuSnapshot still returns only static fields after a version-bumping mutation, and reflects the change", async () => {
    const f = await createFixture();
    const ctx = ownerCtx(f);
    await menu.changePrice(ctx, f.itemId, { price: 999 });

    const snapshot = await menu.getWaiterMenuSnapshot(ctx, f.locationId);
    const item = snapshot.items.find((i) => i.id === f.itemId)!;
    expect(Number(item.price)).toBe(999);
    expect((item as Record<string, unknown>).availability).toBeUndefined();
  });
});
