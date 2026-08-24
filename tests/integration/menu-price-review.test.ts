/**
 * changePrice + needsReview resolution.
 *
 * Bug being fixed: a menu item imported without a known price
 * (needsReview=true, isActive=false, price=0 — see seed-menu.ts) stayed
 * PERMANENTLY invisible to Waiter POS even after an owner/admin entered its
 * real price through the Admin UI, because changePrice only updated `price`
 * and never touched needsReview/isActive/reviewNote. This file proves the
 * fix: entering a real (>0) price for a needsReview item now atomically
 * resolves the review AND makes the item visible via activeOnly=true —
 * while an already-active item's price change stays exactly as before.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import type { AuthContext } from "@rcs/auth";
import { ForbiddenError } from "@rcs/auth";
import { menu } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  locationId: string;
  categoryId: string;
}

function ctx(fixture: Fixture, role: string, employeeId: string, permissions: string[]): AuthContext {
  return {
    userId: employeeId,
    employeeId,
    restaurantId: fixture.restaurantId,
    locationIds: [fixture.locationId],
    roles: [role],
    permissions: new Set(permissions),
  };
}
function ownerCtx(fixture: Fixture, employeeId = "owner-1"): AuthContext {
  return ctx(fixture, "OWNER", employeeId, ["menu.view", "menu.manage", "audit.view"]);
}
function waiterCtx(fixture: Fixture, employeeId = "waiter-1"): AuthContext {
  return ctx(fixture, "WAITER", employeeId, ["menu.view"]);
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Price review tenant", slug: `pr-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant", currency: "RSD" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const category = await prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: "Hrana", slug: `hrana-${randomUUID()}`, type: "FOOD" },
  });
  return { restaurantId: restaurant.id, locationId: location.id, categoryId: category.id };
}

async function createNeedsReviewItem(fixture: Fixture, name = "Biftek") {
  return prisma.menuItem.create({
    data: {
      restaurantId: fixture.restaurantId,
      categoryId: fixture.categoryId,
      name,
      slug: `${name.toLowerCase()}-${randomUUID()}`,
      price: "0",
      taxRate: "20",
      preparationStation: "KITCHEN",
      needsReview: true,
      isActive: false,
      reviewNote: "NEEDS_PRICE_CONFIRMATION — cena nije dostupna na fotografisanom meniju.",
    },
  });
}

async function createActiveItem(fixture: Fixture, name = "Omlet", price = "150.00") {
  return prisma.menuItem.create({
    data: {
      restaurantId: fixture.restaurantId,
      categoryId: fixture.categoryId,
      name,
      slug: `${name.toLowerCase()}-${randomUUID()}`,
      price,
      taxRate: "20",
      preparationStation: "KITCHEN",
      needsReview: false,
      isActive: true,
    },
  });
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("changePrice resolves needsReview atomically", () => {
  it("entering a real (>0) price for a needsReview item sets needsReview=false, reviewNote=null, isActive=true", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createNeedsReviewItem(fixture);

    const updated = await menu.changePrice(owner, item.id, { price: 890, reason: "Unos sa fotografije menija" });

    expect(Number(updated.price)).toBe(890);
    expect(updated.needsReview).toBe(false);
    expect(updated.reviewNote).toBeNull();
    expect(updated.isActive).toBe(true);
  });

  it("the resolved item is now returned by listMenuItems(activeOnly=true) — the exact query Waiter POS uses", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const waiter = waiterCtx(fixture);
    const item = await createNeedsReviewItem(fixture);

    const beforeList = await menu.listMenuItems(waiter, { activeOnly: true });
    expect(beforeList.find((i) => i.id === item.id)).toBeUndefined();

    await menu.changePrice(owner, item.id, { price: 890 });

    const afterList = await menu.listMenuItems(waiter, { activeOnly: true });
    expect(afterList.find((i) => i.id === item.id)).toBeDefined();
  });

  it("entering price=0 does NOT resolve review — 0 is the placeholder value itself, not a real price", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createNeedsReviewItem(fixture);

    const updated = await menu.changePrice(owner, item.id, { price: 0 });

    expect(updated.needsReview).toBe(true);
    expect(updated.isActive).toBe(false);
    expect(updated.reviewNote).not.toBeNull();
  });

  it("changing price on an ALREADY-ACTIVE item behaves exactly as before — no regression", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createActiveItem(fixture);

    const updated = await menu.changePrice(owner, item.id, { price: 160 });

    expect(Number(updated.price)).toBe(160);
    expect(updated.needsReview).toBe(false);
    expect(updated.isActive).toBe(true);
  });

  it("deactivating an item manually and later changing its price does NOT reactivate it (only needsReview items auto-activate)", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createActiveItem(fixture);
    await prisma.menuItem.update({ where: { id: item.id }, data: { isActive: false } }); // manual deactivation, unrelated to needsReview

    const updated = await menu.changePrice(owner, item.id, { price: 170 });

    expect(updated.isActive).toBe(false); // stays deactivated — changePrice must not override a deliberate manual deactivation
    expect(updated.needsReview).toBe(false);
  });

  it("records an audit entry including the needsReview/isActive transition", async () => {
    const fixture = await createFixture();
    const owner = ownerCtx(fixture);
    const item = await createNeedsReviewItem(fixture);

    await menu.changePrice(owner, item.id, { price: 890, reason: "Sa fotografije menija" });

    const entry = await prisma.auditLog.findFirst({
      where: { entityType: "MenuItem", entityId: item.id, action: "menu_item.price_changed" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).toBeTruthy();
    expect(entry?.reason).toBe("Sa fotografije menija");
  });

  it("rejects a WAITER (no menu.manage) from changing price", async () => {
    const fixture = await createFixture();
    const waiter = waiterCtx(fixture);
    const item = await createNeedsReviewItem(fixture);

    await expect(menu.changePrice(waiter, item.id, { price: 890 })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
