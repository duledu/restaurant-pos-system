/**
 * IMAGE MANAGEMENT V1 — tenant isolation, permission enforcement, and
 * upload/replace/remove round-trips for the shared image pipeline
 * (packages/domain/media/image-service.ts). `@vercel/blob` is mocked (no
 * real network call, no real token needed) — everything else (ownership
 * check, permission gate, DB write, best-effort old-object cleanup) runs
 * for real against the disposable test database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { prisma } from "@rcs/db";
import { ForbiddenError, type AuthContext } from "@rcs/auth";
import { media } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

const putMock = vi.fn(async (pathname: string) => ({ url: `https://blob.test.public.blob.vercel-storage.com/${pathname}-mockid` }));
const delMock = vi.fn(async () => undefined);
vi.mock("@vercel/blob", () => ({
  put: (...args: unknown[]) => putMock(...(args as [string])),
  del: (...args: unknown[]) => delMock(...args),
}));

function context(restaurantId: string, employeeId: string, permissions: string[]): AuthContext {
  return { userId: employeeId, employeeId, restaurantId, locationIds: [], roles: ["MANAGER"], permissions: new Set(permissions) };
}

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  itemId: string;
  otherRestaurantItemId: string;
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Image svc tenant", slug: `imgsvc-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restoran A", currency: "RSD" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restoran B" } });
  const category = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: "Roštilj", slug: `rostilj-${randomUUID()}`, type: "FOOD", isActive: true } });
  const item = await prisma.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Ćevapi", slug: `cevapi-${randomUUID()}`, price: "600.00", taxRate: "20", isActive: true, isAvailable: true } });
  const otherCategory = await prisma.menuCategory.create({ data: { restaurantId: otherRestaurant.id, name: "Roštilj", slug: `rostilj-b-${randomUUID()}`, type: "FOOD", isActive: true } });
  const otherItem = await prisma.menuItem.create({ data: { restaurantId: otherRestaurant.id, categoryId: otherCategory.id, name: "Tuđi artikal", slug: `tudji-${randomUUID()}`, price: "500.00", taxRate: "20", isActive: true, isAvailable: true } });
  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, itemId: item.id, otherRestaurantItemId: otherItem.id };
}

async function realPngUpload() {
  const buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  return { buffer, declaredSize: buffer.byteLength };
}

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
  putMock.mockClear();
  delMock.mockClear();
});

describe("uploadMenuItemImage — tenant isolation, permissions, persistence", () => {
  it("rejects a caller without menu.manage", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", []);
    await expect(media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload())).rejects.toThrow(ForbiddenError);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("rejects uploading to another restaurant's menu item, even with menu.manage — a client cannot cross tenant boundaries by supplying a foreign itemId", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    await expect(media.uploadMenuItemImage(ctx, fixture.otherRestaurantItemId, await realPngUpload())).rejects.toThrow("Artikal nije pronađen");
    expect(putMock).not.toHaveBeenCalled();
  });

  it("uploads, persists the resulting URL on MenuItem.imageUrl, and the public menu picks it up (single source of truth)", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    const url = await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    expect(url).toContain(".public.blob.vercel-storage.com/");
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.itemId } });
    expect(item.imageUrl).toBe(url);
  });

  it("on replace, deletes the OLD blob only after the new one is safely persisted (safe-replace ordering)", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    const firstUrl = await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    const secondUrl = await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    expect(secondUrl).not.toBe(firstUrl);
    expect(delMock).toHaveBeenCalledWith(firstUrl);
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.itemId } });
    expect(item.imageUrl).toBe(secondUrl);
  });

  it("rejects a non-image payload without ever calling blob storage", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    const garbage = { buffer: Buffer.from("not an image"), declaredSize: 12 };
    await expect(media.uploadMenuItemImage(ctx, fixture.itemId, garbage)).rejects.toThrow(/format/i);
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe("removeMenuItemImage", () => {
  it("clears imageUrl and best-effort deletes the blob", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    const url = await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    await media.removeMenuItemImage(ctx, fixture.itemId);
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.itemId } });
    expect(item.imageUrl).toBeNull();
    expect(delMock).toHaveBeenCalledWith(url);
  });

  it("is a safe no-op when the item never had an image", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    await expect(media.removeMenuItemImage(ctx, fixture.itemId)).resolves.toBeUndefined();
    expect(delMock).not.toHaveBeenCalled();
  });
});

describe("uploadQrHeroImage / removeQrHeroImage — QrMenuSettings.coverImageUrl", () => {
  it("rejects without qr_menu.manage", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["qr_menu.view"]);
    await expect(media.uploadQrHeroImage(ctx, await realPngUpload())).rejects.toThrow(ForbiddenError);
  });

  it("uploads and persists on a restaurant with no prior QrMenuSettings row (lazy-create convention)", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["qr_menu.manage"]);
    const url = await media.uploadQrHeroImage(ctx, await realPngUpload());
    const settings = await prisma.qrMenuSettings.findUniqueOrThrow({ where: { restaurantId: fixture.restaurantId } });
    expect(settings.coverImageUrl).toBe(url);
  });

  it("remove clears coverImageUrl and best-effort deletes the blob", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["qr_menu.manage"]);
    const url = await media.uploadQrHeroImage(ctx, await realPngUpload());
    await media.removeQrHeroImage(ctx);
    const settings = await prisma.qrMenuSettings.findUniqueOrThrow({ where: { restaurantId: fixture.restaurantId } });
    expect(settings.coverImageUrl).toBeNull();
    expect(delMock).toHaveBeenCalledWith(url);
  });
});

describe("uploadRestaurantLogo / removeRestaurantLogo — RestaurantSettings.logoUrl (shared with public menu identity)", () => {
  it("rejects without qr_menu.manage", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", []);
    await expect(media.uploadRestaurantLogo(ctx, await realPngUpload())).rejects.toThrow(ForbiddenError);
  });

  it("uploads and persists on RestaurantSettings, isolated per restaurant", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["qr_menu.manage"]);
    const otherCtx = context(fixture.otherRestaurantId, "e2", ["qr_menu.manage"]);
    const url = await media.uploadRestaurantLogo(ctx, await realPngUpload());
    const otherUrl = await media.uploadRestaurantLogo(otherCtx, await realPngUpload());
    expect(url).not.toBe(otherUrl);
    const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { restaurantId: fixture.restaurantId } });
    const otherSettings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { restaurantId: fixture.otherRestaurantId } });
    expect(settings.logoUrl).toBe(url);
    expect(otherSettings.logoUrl).toBe(otherUrl);
  });
});
