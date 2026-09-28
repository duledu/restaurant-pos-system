/**
 * Branded QR Menu V1 — single source of truth (existing Category/MenuItem
 * data), per-restaurant branding, and public route security/isolation.
 * See packages/domain/qrmenu/qr-menu-service.ts's module doc comment.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError, type AuthContext } from "@rcs/auth";
import { qrMenu } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
  categoryId: string;
  activeItemId: string; // "Pljeskavica", active+available
  unavailableItemId: string; // active, but temporarily unavailable
  inactiveItemId: string; // isActive=false — must never appear publicly
}

function context(restaurantId: string, locationId: string, role: string, employeeId: string, permissions = new Set<string>()): AuthContext {
  return { userId: employeeId, employeeId, restaurantId, locationIds: [locationId], roles: [role], permissions };
}

function managerCtx(fixture: Fixture, employeeId = "mgr-1"): AuthContext {
  return context(fixture.restaurantId, fixture.locationId, "MANAGER", employeeId, new Set(["qr_menu.view", "qr_menu.manage", "settings.manage", "audit.view"]));
}
function otherRestaurantManagerCtx(fixture: Fixture, employeeId = "mgr-b"): AuthContext {
  return context(fixture.otherRestaurantId, fixture.otherLocationId, "MANAGER", employeeId, new Set(["qr_menu.view", "qr_menu.manage", "settings.manage"]));
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "QR menu tenant", slug: `qrmenu-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Stari Hrast", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: otherRestaurant.id, name: "Main" } });

  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Roštilj", slug: `rostilj-${randomUUID()}`, type: "FOOD", isActive: true } });
  const activeItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Pljeskavica", slug: `pljeskavica-${randomUUID()}`, description: "Domaća, 250g", price: "650.00", taxRate: "20", isActive: true, isAvailable: true, imageUrl: "https://example.com/pljeskavica.jpg", preparationStation: "KITCHEN" },
  });
  const unavailableItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Ćevapi", slug: `cevapi-${randomUUID()}`, price: "600.00", taxRate: "20", isActive: true, isAvailable: false },
  });
  const inactiveItem = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: "Sezonsko jelo (arhivirano)", slug: `sezonsko-${randomUUID()}`, price: "500.00", taxRate: "20", isActive: false, isAvailable: true },
  });

  return {
    restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id,
    locationId: location.id, otherLocationId: otherLocation.id,
    categoryId: category.id, activeItemId: activeItem.id, unavailableItemId: unavailableItem.id, inactiveItemId: inactiveItem.id,
  };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("getPublicMenu — single source of truth (spec section 1)", () => {
  it("returns null for an unknown slug", async () => {
    const menu = await qrMenu.getPublicMenu("no-such-restaurant");
    expect(menu).toBeNull();
  });

  it("returns null when the restaurant has no slug set at all", async () => {
    await createFixture();
    const menu = await qrMenu.getPublicMenu("");
    expect(menu).toBeNull();
  });

  it("reflects the exact same active MenuItem/MenuCategory data — no duplicate menu database", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });

    const menu = await qrMenu.getPublicMenu("stari-hrast");
    expect(menu).not.toBeNull();
    const items = menu!.categories.flatMap((c) => c.items);
    const pljeskavica = items.find((i) => i.id === fixture.activeItemId);
    expect(pljeskavica).toMatchObject({ name: "Pljeskavica", description: "Domaća, 250g", price: "650", imageUrl: "https://example.com/pljeskavica.jpg", isAvailable: true, preparationStation: "KITCHEN" });
    expect(menu!.categories[0].type).toBe("FOOD");
  });

  it("slug lookup is case-insensitive (normalized to lowercase)", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    const menu = await qrMenu.getPublicMenu("STARI-HRAST");
    expect(menu).not.toBeNull();
  });

  it("includes an unavailable (but active) item, flagged — never hides it (spec section 17)", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    const menu = await qrMenu.getPublicMenu("stari-hrast");
    const cevapi = menu!.categories.flatMap((c) => c.items).find((i) => i.id === fixture.unavailableItemId);
    expect(cevapi).toBeTruthy();
    expect(cevapi!.isAvailable).toBe(false);
  });

  it("NEVER includes an inactive (isActive=false) item — master on/off switch means fully excluded", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    const menu = await qrMenu.getPublicMenu("stari-hrast");
    const ids = menu!.categories.flatMap((c) => c.items).map((i) => i.id);
    expect(ids).not.toContain(fixture.inactiveItemId);
  });

  it("a category with zero visible items is omitted entirely", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    await prisma.menuItem.updateMany({ where: { restaurantId: fixture.restaurantId }, data: { isActive: false } });
    const menu = await qrMenu.getPublicMenu("stari-hrast");
    expect(menu!.categories).toHaveLength(0);
  });
});

describe("getPublicMenu — safe public data projection (spec section 22/24), never leaks private fields", () => {
  it("the returned payload contains no internal/operational fields (cost, employee, inventory, audit, permissions)", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    const menu = await qrMenu.getPublicMenu("stari-hrast");
    const serialized = JSON.stringify(menu);
    expect(serialized).not.toContain(fixture.restaurantId); // no raw restaurant id anywhere in the payload
    expect(serialized.toLowerCase()).not.toMatch(/purchaseprice|cost|employee|inventory|audit|permission|recipe/);
    expect(Object.keys(menu!.categories[0].items[0]).sort()).toEqual(["description", "id", "imageUrl", "isAvailable", "name", "preparationStation", "price"]);
  });

  it("a SUSPENDED restaurant is never publicly reachable, indistinguishable from a nonexistent slug", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast", status: "SUSPENDED" } });
    const menu = await qrMenu.getPublicMenu("stari-hrast");
    expect(menu).toBeNull();
  });

  it("an ARCHIVED restaurant is never publicly reachable", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast", status: "ARCHIVED" } });
    const menu = await qrMenu.getPublicMenu("stari-hrast");
    expect(menu).toBeNull();
  });

  it("isPublished=false makes the menu unreachable without deleting any configuration", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    await prisma.qrMenuSettings.create({ data: { restaurantId: fixture.restaurantId, isPublished: false } });
    const menu = await qrMenu.getPublicMenu("stari-hrast");
    expect(menu).toBeNull();
  });
});

describe("getPublicMenu — branding fallback (spec section 26), a polished default with zero configuration", () => {
  it("a restaurant with no QrMenuSettings row at all still gets a complete, valid theme and no crash", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    const menu = await qrMenu.getPublicMenu("stari-hrast");
    expect(menu!.theme.themePreset).toBe("WARM");
    expect(menu!.theme.typographyPreset).toBe("MODERN");
    expect(menu!.theme.cardStyle).toBe("BALANCED");
    expect(menu!.restaurant.logoUrl).toBeNull();
    expect(menu!.restaurant.coverImageUrl).toBeNull();
    expect(menu!.restaurant.tagline).toBeNull();
  });
});

describe("getPublicMenu — table-aware QR (spec section 10), view-only", () => {
  it("a valid table token resolves the table label", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    const floor = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "Sala" } });
    const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "7" } });
    const ctx = managerCtx(fixture);
    const token = await qrMenu.getOrCreateTableQrToken(ctx, table.id);

    const menu = await qrMenu.getPublicMenu("stari-hrast", token);
    expect(menu!.table).toEqual({ label: "7" });
  });

  it("an unknown/invalid table token silently resolves to no table context (never an error, never blocks the menu)", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    const menu = await qrMenu.getPublicMenu("stari-hrast", "not-a-real-token");
    expect(menu).not.toBeNull();
    expect(menu!.table).toBeNull();
  });

  it("a table token from ANOTHER restaurant never resolves — cross-tenant table leakage is impossible", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    await prisma.restaurant.update({ where: { id: fixture.otherRestaurantId }, data: { slug: "restaurant-b" } });
    const floorB = await prisma.floor.create({ data: { restaurantId: fixture.otherRestaurantId, locationId: fixture.otherLocationId, name: "Sala B" } });
    const tableB = await prisma.restaurantTable.create({ data: { floorId: floorB.id, label: "3" } });
    const ctxB = otherRestaurantManagerCtx(fixture);
    const tokenB = await qrMenu.getOrCreateTableQrToken(ctxB, tableB.id);

    // Token is real, but scanned against restaurant A's slug — must not leak restaurant B's table.
    const menu = await qrMenu.getPublicMenu("stari-hrast", tokenB);
    expect(menu!.table).toBeNull();
  });

  it("does NOT create an Order, does NOT change RestaurantTable.status, is purely view-only (spec section 10/23)", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    const floor = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "Sala" } });
    const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "9" } });
    const ctx = managerCtx(fixture);
    const token = await qrMenu.getOrCreateTableQrToken(ctx, table.id);

    await qrMenu.getPublicMenu("stari-hrast", token);
    await qrMenu.getPublicMenu("stari-hrast", token); // repeat "scan"

    const orderCount = await prisma.order.count({ where: { tableId: table.id } });
    expect(orderCount).toBe(0);
    const tableAfter = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: table.id } });
    expect(tableAfter.status).toBe("FREE");
  });
});

describe("Multi-tenant isolation (spec section 24, critical)", () => {
  it("Restaurant A's public menu never contains Restaurant B's categories or items", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    const categoryB = await prisma.menuCategory.create({ data: { restaurantId: fixture.otherRestaurantId, name: "Restaurant B Category", slug: `b-cat-${randomUUID()}`, type: "FOOD" } });
    await prisma.menuItem.create({ data: { restaurantId: fixture.otherRestaurantId, categoryId: categoryB.id, name: "Restaurant B Secret Dish", slug: `b-item-${randomUUID()}`, price: "999.00", taxRate: "20" } });

    const menu = await qrMenu.getPublicMenu("stari-hrast");
    const names = menu!.categories.flatMap((c) => [c.name, ...c.items.map((i) => i.name)]);
    expect(names).not.toContain("Restaurant B Category");
    expect(names).not.toContain("Restaurant B Secret Dish");
  });

  it("Restaurant A admin cannot read or edit Restaurant B's QR menu settings", async () => {
    const fixture = await createFixture();
    const ctxA = managerCtx(fixture);
    const ctxB = otherRestaurantManagerCtx(fixture);
    await qrMenu.updateQrMenuSettings(ctxB, { tagline: "B's secret tagline", coverImageUrl: null, themePreset: "DARK", accentColor: null, typographyPreset: "CASUAL", cardStyle: "COMPACT", imageShape: "SQUARE", isPublished: true });

    const settingsA = await qrMenu.getQrMenuSettings(ctxA);
    expect(settingsA.tagline).not.toBe("B's secret tagline");
    expect(settingsA.themePreset).toBe("WARM"); // A's own default, untouched
  });

  it("Restaurant A cannot generate/read a QR token for Restaurant B's table", async () => {
    const fixture = await createFixture();
    const floorB = await prisma.floor.create({ data: { restaurantId: fixture.otherRestaurantId, locationId: fixture.otherLocationId, name: "Sala B" } });
    const tableB = await prisma.restaurantTable.create({ data: { floorId: floorB.id, label: "1" } });
    const ctxA = managerCtx(fixture);
    await expect(qrMenu.getOrCreateTableQrToken(ctxA, tableB.id)).rejects.toThrow(/nije pronađen/);
  });

  it("restaurant slugs are globally unique — Restaurant B cannot claim Restaurant A's slug", async () => {
    const fixture = await createFixture();
    const ctxA = managerCtx(fixture);
    const ctxB = otherRestaurantManagerCtx(fixture);
    await qrMenu.updateRestaurantSlug(ctxA, "stari-hrast");
    await expect(qrMenu.updateRestaurantSlug(ctxB, "stari-hrast")).rejects.toThrow(/već zauzeta/);
  });
});

describe("Admin CRUD — permissions (spec section 31) and audit", () => {
  it("a role without qr_menu.manage cannot update settings", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, fixture.locationId, "WAITER", "w1", new Set(["qr_menu.view"]));
    await expect(
      qrMenu.updateQrMenuSettings(ctx, { tagline: null, coverImageUrl: null, themePreset: "LIGHT", accentColor: null, typographyPreset: "MODERN", cardStyle: "BALANCED", imageShape: "ROUNDED", isPublished: true })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a role without qr_menu.view cannot even read settings", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, fixture.locationId, "WAITER", "w1", new Set());
    await expect(qrMenu.getQrMenuSettings(ctx)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("viewing the PUBLIC menu itself requires no permission at all", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    // getPublicMenu takes no AuthContext whatsoever — this is the point.
    const menu = await qrMenu.getPublicMenu("stari-hrast");
    expect(menu).not.toBeNull();
  });

  it("updating settings is audited with before/after values", async () => {
    const fixture = await createFixture();
    const ctx = managerCtx(fixture);
    await qrMenu.updateQrMenuSettings(ctx, { tagline: "Prvi slogan", coverImageUrl: null, themePreset: "WARM", accentColor: null, typographyPreset: "MODERN", cardStyle: "BALANCED", imageShape: "ROUNDED", isPublished: true });
    await qrMenu.updateQrMenuSettings(ctx, { tagline: "Novi slogan", coverImageUrl: null, themePreset: "DARK", accentColor: null, typographyPreset: "ELEGANT", cardStyle: "COMPACT", imageShape: "SQUARE", isPublished: true });

    const audits = await prisma.auditLog.findMany({ where: { entityType: "QrMenuSettings", entityId: fixture.restaurantId, action: "qr_menu.settings_updated" }, orderBy: { createdAt: "asc" } });
    expect(audits).toHaveLength(2);
    expect((audits[1].previousValue as { tagline: string }).tagline).toBe("Prvi slogan");
    expect((audits[1].newValue as { tagline: string }).tagline).toBe("Novi slogan");
  });

  it("getOrCreateTableQrToken is idempotent — repeated calls return the SAME token, never regenerate", async () => {
    const fixture = await createFixture();
    const floor = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "Sala" } });
    const table = await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "5" } });
    const ctx = managerCtx(fixture);
    const first = await qrMenu.getOrCreateTableQrToken(ctx, table.id);
    const second = await qrMenu.getOrCreateTableQrToken(ctx, table.id);
    expect(first).toBe(second);
  });

  it("listTablesForQr only returns this restaurant's tables", async () => {
    const fixture = await createFixture();
    const floor = await prisma.floor.create({ data: { restaurantId: fixture.restaurantId, locationId: fixture.locationId, name: "Sala" } });
    await prisma.restaurantTable.create({ data: { floorId: floor.id, label: "1" } });
    const floorB = await prisma.floor.create({ data: { restaurantId: fixture.otherRestaurantId, locationId: fixture.otherLocationId, name: "Sala B" } });
    await prisma.restaurantTable.create({ data: { floorId: floorB.id, label: "1" } });

    const ctxA = managerCtx(fixture);
    const floorsA = await qrMenu.listTablesForQr(ctxA);
    const allTableIds = floorsA.flatMap((f) => f.tables.map((t) => t.id));
    const floorNames = floorsA.map((f) => f.name);
    expect(floorNames).not.toContain("Sala B");
    expect(allTableIds.length).toBeGreaterThan(0);
  });
});

describe("Regression — QR Menu does not create a second menu database (spec section 1)", () => {
  it("editing a MenuItem in TableCore is immediately reflected in the public menu — no publish step, no sync", async () => {
    const fixture = await createFixture();
    await prisma.restaurant.update({ where: { id: fixture.restaurantId }, data: { slug: "stari-hrast" } });
    const before = await qrMenu.getPublicMenu("stari-hrast");
    const priceBefore = before!.categories.flatMap((c) => c.items).find((i) => i.id === fixture.activeItemId)!.price;
    expect(priceBefore).toBe("650");

    await prisma.menuItem.update({ where: { id: fixture.activeItemId }, data: { price: "700.00" } });

    const after = await qrMenu.getPublicMenu("stari-hrast");
    const priceAfter = after!.categories.flatMap((c) => c.items).find((i) => i.id === fixture.activeItemId)!.price;
    expect(priceAfter).toBe("700");
  });
});
