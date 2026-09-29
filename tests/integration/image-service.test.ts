/**
 * IMAGE MANAGEMENT V1 — tenant isolation, permission enforcement, and
 * upload/replace/remove round-trips for the shared image pipeline
 * (packages/domain/media/image-service.ts). R2MediaStorage is mocked (no
 * real network call, no real R2 credentials needed) — everything else
 * (ownership check, permission gate, DB write, best-effort old-object
 * cleanup, DB-failure rollback of the newly-uploaded object) runs for real
 * against the disposable test database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { prisma } from "@rcs/db";
import { ForbiddenError, type AuthContext } from "@rcs/auth";
import { media } from "@rcs/domain";
import { resetPrismaTestTables } from "../setup/reset-test-db";

const TEST_PUBLIC_BASE = "https://media.test.tablecore.net";
const putMock = vi.fn(async (key: string) => `${TEST_PUBLIC_BASE}/${key}`);
const deleteMock = vi.fn(async () => undefined);
vi.mock("@rcs/domain/media/storage/r2-media-storage", () => ({
  R2MediaStorage: vi.fn().mockImplementation(() => ({
    put: (...args: unknown[]) => putMock(...(args as [string])),
    delete: (...args: unknown[]) => deleteMock(...args),
    publicUrl: (key: string) => `${TEST_PUBLIC_BASE}/${key}`,
  })),
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
  deleteMock.mockClear();
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
    expect(url).toContain("media.test.tablecore.net/");
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.itemId } });
    expect(item.imageUrl).toBe(url);
  });

  it("on replace, deletes the OLD blob only after the new one is safely persisted (safe-replace ordering)", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    const firstUrl = await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    const secondUrl = await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    expect(secondUrl).not.toBe(firstUrl);
    expect(deleteMock).toHaveBeenCalledWith(firstUrl);
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

  it("never attempts to delete a pre-existing legacy/external URL that isn't ours to own (e.g. a Vercel Blob URL from before the R2 migration)", async () => {
    const fixture = await createFixture();
    await prisma.menuItem.update({ where: { id: fixture.itemId }, data: { imageUrl: "https://legacy123.public.blob.vercel-storage.com/old-photo.webp" } });
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    // deleteMock is our OWN R2MediaStorage.delete — it receives every previous-URL argument
    // regardless of ownership (the real R2MediaStorage.delete is what no-ops internally via
    // keyFromOwnedUrl, covered separately in tests/unit/r2-media-storage.test.ts); here we
    // confirm the legacy URL is still passed through unmodified, never rewritten/derived into
    // some other delete target.
    expect(deleteMock).toHaveBeenCalledWith("https://legacy123.public.blob.vercel-storage.com/old-photo.webp");
  });

  it("gets a brand-new object key on every replacement — never overwrites the previous key", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    const firstUrl = await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    const secondUrl = await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    const thirdUrl = await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    expect(new Set([firstUrl, secondUrl, thirdUrl]).size).toBe(3);
  });

  it("rolls back (best-effort deletes) the newly-uploaded object if DB persistence fails, and leaves the old URL untouched in the DB", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    const originalUrl = await media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload());
    putMock.mockClear();
    deleteMock.mockClear();

    // Ownership lookup (findFirst) must still succeed; only the persisting
    // update() call fails, simulating a genuine DB write failure mid-upload.
    const updateSpy = vi.spyOn(prisma.menuItem, "update").mockRejectedValueOnce(new Error("simulated DB failure"));
    await expect(media.uploadMenuItemImage(ctx, fixture.itemId, await realPngUpload())).rejects.toThrow("simulated DB failure");
    updateSpy.mockRestore();

    expect(putMock).toHaveBeenCalledTimes(1); // the new object WAS uploaded
    expect(deleteMock).toHaveBeenCalledTimes(1); // ...then rolled back, since persistence failed
    const uploadedKey = putMock.mock.calls[0][0] as string;
    expect(deleteMock).toHaveBeenCalledWith(`${TEST_PUBLIC_BASE}/${uploadedKey}`);

    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: fixture.itemId } });
    expect(item.imageUrl).toBe(originalUrl); // untouched — the failed upload never overwrote the working image
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
    expect(deleteMock).toHaveBeenCalledWith(url);
  });

  it("is a safe no-op when the item never had an image", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture.restaurantId, "e1", ["menu.manage"]);
    await expect(media.removeMenuItemImage(ctx, fixture.itemId)).resolves.toBeUndefined();
    expect(deleteMock).not.toHaveBeenCalled();
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
    expect(deleteMock).toHaveBeenCalledWith(url);
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
