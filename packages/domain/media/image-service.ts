/**
 * IMAGE MANAGEMENT V1 — one shared upload/replace/remove pipeline for the
 * three image roles TableCore's public QR Menu already knows how to render
 * (MenuItem.imageUrl, QrMenuSettings.coverImageUrl, RestaurantSettings.logoUrl).
 * No new database fields — existing fields are reused, existing SSRF-safe
 * plain-<img> public rendering is untouched.
 *
 * STORAGE: Cloudflare R2 (packages/domain/media/storage/r2-media-storage.ts),
 * the canonical TableCore media store — ONE bucket (tablecore-production-media)
 * shared by PREPROD and Production, served publicly under R2_PUBLIC_BASE_URL
 * (media.tablecore.net). Migrated from Vercel Blob (see git history) —
 * that migration only ever touched this file's storage calls; every
 * ownership/permission/validation rule below is unchanged.
 *
 * SECURITY: this module NEVER fetches a remote URL on the caller's behalf —
 * the only inputs are raw bytes the browser already uploaded (multipart
 * form data), so the SSRF class of bug already fixed for coverImageUrl
 * (paste-a-URL-and-the-server-fetches-it) cannot reoccur through this path.
 * MIME is verified from the file's own magic bytes, never trusted from the
 * browser-supplied Content-Type or filename extension. SVG is never
 * accepted (it can embed script). Every write resolves its target's
 * ownership from `ctx.restaurantId` (server-derived from the session) —
 * a caller can never point at another tenant's row by supplying an id.
 * Deletion only ever targets a URL that was issued under our OWN configured
 * R2_PUBLIC_BASE_URL (see keyFromOwnedUrl) — a legacy Vercel Blob URL from
 * before this migration, or any external URL, is silently left alone.
 */
import { randomUUID } from "crypto";
import sharp from "sharp";
import { prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { R2MediaStorage, type MediaStorage } from "./storage/r2-media-storage";

const MENU_MANAGE = "menu.manage";
const QR_MENU_MANAGE = "qr_menu.manage";

export type ImageAssetRole = "MENU_ITEM_IMAGE" | "QR_HERO_IMAGE" | "RESTAURANT_LOGO";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // raw upload cap, before processing

export class ImageValidationError extends Error {}

// ── MIME sniffing from magic bytes — never trust the browser's declared
// Content-Type or the filename extension (spec: "Do not trust file
// extension alone"). SVG is deliberately absent: it is not detected here
// and therefore always falls through to the rejection path below.
// Exported for direct unit testing (pure, no DB/network).
export function sniffImageMime(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  return null;
}

interface RoleProcessing {
  resize: { width: number; height: number };
  format: "webp" | "png";
  extension: "webp" | "png";
  /** Object-key folder, matching the canonical R2 layout (Step 3). */
  keyFolder: (restaurantId: string, targetId?: string) => string;
}

// Different roles need different treatment (spec: menu item = thumbnail/
// detail scale, hero = larger landscape asset, logo = smaller identity
// asset with transparency preserved). WebP everywhere except the logo,
// which stays PNG so a transparent source (the common case for a brand
// mark) never gets flattened onto a background color. MENU_ITEM_IMAGE is
// 512×512 (corrected down from an earlier 1000×1000 — a thumbnail/detail
// image never needs to be larger than this).
const ROLE_PROCESSING: Record<ImageAssetRole, RoleProcessing> = {
  MENU_ITEM_IMAGE: {
    resize: { width: 512, height: 512 },
    format: "webp",
    extension: "webp",
    keyFolder: (restaurantId, itemId) => `restaurants/${restaurantId}/menu-items/${itemId}`,
  },
  QR_HERO_IMAGE: {
    resize: { width: 1920, height: 1080 },
    format: "webp",
    extension: "webp",
    keyFolder: (restaurantId) => `restaurants/${restaurantId}/branding/hero`,
  },
  RESTAURANT_LOGO: {
    resize: { width: 512, height: 512 },
    format: "png",
    extension: "png",
    keyFolder: (restaurantId) => `restaurants/${restaurantId}/branding/logo`,
  },
};

/** Exported for direct unit testing (pure image transform, no DB/network) — the same per-role resize/format/EXIF pipeline every upload runs. */
export async function processImage(buffer: Buffer, role: ImageAssetRole): Promise<Buffer> {
  const { resize, format } = ROLE_PROCESSING[role];
  let pipeline = sharp(buffer, { failOn: "error" }).rotate(); // .rotate() with no args = auto-orient from EXIF, then strip it
  pipeline = pipeline.resize(resize.width, resize.height, { fit: "inside", withoutEnlargement: true });
  pipeline = format === "webp" ? pipeline.webp({ quality: 82 }) : pipeline.png({ compressionLevel: 9 });
  try {
    return await pipeline.toBuffer();
  } catch {
    // sharp throws on truncated/corrupted/non-image data even when the
    // magic bytes superficially matched — treat that as the same class of
    // validation failure as a MIME mismatch, not a 500.
    throw new ImageValidationError("Fajl nije validna slika ili je oštećen.");
  }
}

export interface RawUpload {
  buffer: Buffer;
  declaredSize: number;
}

/** Exported for direct unit testing (pure, no DB/network) — the same check every upload path runs before any processing/storage happens. */
export function validateRawUpload(upload: RawUpload): void {
  if (upload.declaredSize > MAX_UPLOAD_BYTES || upload.buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new ImageValidationError("Fajl je prevelik (maksimum 10 MB).");
  }
  const mime = sniffImageMime(upload.buffer);
  if (!mime) {
    throw new ImageValidationError("Dozvoljeni formati su JPEG, PNG i WebP.");
  }
}

// A single storage instance per process — R2MediaStorage's own constructor
// reads env lazily (getR2Config throws a clean error on first real use, not
// at module import), and its S3 client is itself cached internally.
let sharedStorage: MediaStorage | undefined;
function storage(): MediaStorage {
  if (!sharedStorage) sharedStorage = new R2MediaStorage();
  return sharedStorage;
}

/** Uploads + processes, but does NOT touch the database or delete anything old — the three role-specific functions below own that (each has a different target table/ownership check). Every replacement gets a brand-new UUID key — never overwrites an existing object (spec Step 3: avoids stale-CDN/browser-cache problems). */
async function uploadProcessed(upload: RawUpload, role: ImageAssetRole, restaurantId: string, targetId?: string): Promise<string> {
  validateRawUpload(upload);
  const processed = await processImage(upload.buffer, role);
  const { extension, format, keyFolder } = ROLE_PROCESSING[role];
  const key = `${keyFolder(restaurantId, targetId)}/${randomUUID()}.${extension}`;
  return storage().put(key, processed, format === "webp" ? "image/webp" : "image/png");
}

/** Best-effort delete of a previously-stored object — failure here must never break the restaurant's menu (spec Phase 7). MediaStorage.delete() itself no-ops for any URL it didn't issue (a legacy Vercel Blob URL, an external URL). */
async function deleteMediaBestEffort(url: string | null): Promise<void> {
  if (!url) return;
  try {
    await storage().delete(url);
  } catch (err) {
    console.error("[image-service] best-effort media delete failed", { err });
  }
}

/** Shared upload lifecycle for all three roles (spec Step 5): upload the new object, persist it, and only THEN best-effort-delete the old one. If DB persistence itself fails, the newly-uploaded object is cleaned up (best-effort) and the old, still-correct URL is left untouched — a failed save never destroys a working image. */
async function uploadAndPersist(
  upload: RawUpload,
  role: ImageAssetRole,
  restaurantId: string,
  targetId: string | undefined,
  previousUrl: string | null,
  persist: (newUrl: string) => Promise<void>
): Promise<string> {
  const newUrl = await uploadProcessed(upload, role, restaurantId, targetId);
  try {
    await persist(newUrl);
  } catch (err) {
    await deleteMediaBestEffort(newUrl); // roll back the orphaned new object — the old URL is still the correct, persisted one
    throw err;
  }
  await deleteMediaBestEffort(previousUrl);
  return newUrl;
}

// ── MENU_ITEM_IMAGE ─────────────────────────────────────────────────────

async function getOwnedMenuItem(ctx: AuthContext, itemId: string) {
  const item = await prisma.menuItem.findFirst({ where: { id: itemId, ...scopeToRestaurant(ctx), deletedAt: null } });
  if (!item) throw new Error("Artikal nije pronađen");
  return item;
}

export async function uploadMenuItemImage(ctx: AuthContext, itemId: string, upload: RawUpload): Promise<string> {
  requirePermission(ctx, MENU_MANAGE);
  const item = await getOwnedMenuItem(ctx, itemId);
  const url = await uploadAndPersist(upload, "MENU_ITEM_IMAGE", ctx.restaurantId, itemId, item.imageUrl, async (newUrl) => {
    await prisma.menuItem.update({ where: { id: itemId }, data: { imageUrl: newUrl } });
  });
  await recordAuditEntry(ctx, { entityType: "MenuItem", entityId: itemId, action: "menu_item.image_uploaded", previousValue: { imageUrl: item.imageUrl }, newValue: { imageUrl: url } });
  return url;
}

export async function removeMenuItemImage(ctx: AuthContext, itemId: string): Promise<void> {
  requirePermission(ctx, MENU_MANAGE);
  const item = await getOwnedMenuItem(ctx, itemId);
  if (!item.imageUrl) return;
  await prisma.menuItem.update({ where: { id: itemId }, data: { imageUrl: null } });
  await deleteMediaBestEffort(item.imageUrl);
  await recordAuditEntry(ctx, { entityType: "MenuItem", entityId: itemId, action: "menu_item.image_removed", previousValue: { imageUrl: item.imageUrl }, newValue: { imageUrl: null } });
}

// ── QR_HERO_IMAGE (QrMenuSettings.coverImageUrl) ────────────────────────

export async function uploadQrHeroImage(ctx: AuthContext, upload: RawUpload): Promise<string> {
  requirePermission(ctx, QR_MENU_MANAGE);
  const previous = await prisma.qrMenuSettings.findUnique({ where: { restaurantId: ctx.restaurantId }, select: { coverImageUrl: true } });
  const url = await uploadAndPersist(upload, "QR_HERO_IMAGE", ctx.restaurantId, undefined, previous?.coverImageUrl ?? null, async (newUrl) => {
    await prisma.qrMenuSettings.upsert({
      where: { restaurantId: ctx.restaurantId },
      create: { restaurantId: ctx.restaurantId, coverImageUrl: newUrl, updatedBy: ctx.employeeId },
      update: { coverImageUrl: newUrl, updatedBy: ctx.employeeId },
    });
  });
  await recordAuditEntry(ctx, { entityType: "QrMenuSettings", entityId: ctx.restaurantId, action: "qr_menu.hero_uploaded", previousValue: { coverImageUrl: previous?.coverImageUrl ?? null }, newValue: { coverImageUrl: url }, category: "qr_menu" });
  return url;
}

export async function removeQrHeroImage(ctx: AuthContext): Promise<void> {
  requirePermission(ctx, QR_MENU_MANAGE);
  const previous = await prisma.qrMenuSettings.findUnique({ where: { restaurantId: ctx.restaurantId }, select: { coverImageUrl: true } });
  if (!previous?.coverImageUrl) return;
  await prisma.qrMenuSettings.update({ where: { restaurantId: ctx.restaurantId }, data: { coverImageUrl: null, updatedBy: ctx.employeeId } });
  await deleteMediaBestEffort(previous.coverImageUrl);
  await recordAuditEntry(ctx, { entityType: "QrMenuSettings", entityId: ctx.restaurantId, action: "qr_menu.hero_removed", previousValue: { coverImageUrl: previous.coverImageUrl }, newValue: { coverImageUrl: null }, category: "qr_menu" });
}

// ── RESTAURANT_LOGO (RestaurantSettings.logoUrl) ────────────────────────
// Gated on qr_menu.manage (not settings.manage): this is reached from the
// QR Menu → Branding admin surface, and every role that holds qr_menu.manage
// (OWNER/ADMIN/MANAGER) already holds settings.manage too (see
// packages/db/prisma/seed.ts ROLE_PERMISSIONS) — same effective access,
// gated by the permission that actually matches the page the action lives on.

export async function uploadRestaurantLogo(ctx: AuthContext, upload: RawUpload): Promise<string> {
  requirePermission(ctx, QR_MENU_MANAGE);
  const previous = await prisma.restaurantSettings.findUnique({ where: { restaurantId: ctx.restaurantId }, select: { logoUrl: true } });
  const url = await uploadAndPersist(upload, "RESTAURANT_LOGO", ctx.restaurantId, undefined, previous?.logoUrl ?? null, async (newUrl) => {
    await prisma.restaurantSettings.upsert({
      where: { restaurantId: ctx.restaurantId },
      create: { restaurantId: ctx.restaurantId, logoUrl: newUrl },
      update: { logoUrl: newUrl },
    });
  });
  await recordAuditEntry(ctx, { entityType: "RestaurantSettings", entityId: ctx.restaurantId, action: "restaurant.logo_uploaded", previousValue: { logoUrl: previous?.logoUrl ?? null }, newValue: { logoUrl: url }, category: "qr_menu" });
  return url;
}

export async function removeRestaurantLogo(ctx: AuthContext): Promise<void> {
  requirePermission(ctx, QR_MENU_MANAGE);
  const previous = await prisma.restaurantSettings.findUnique({ where: { restaurantId: ctx.restaurantId }, select: { logoUrl: true } });
  if (!previous?.logoUrl) return;
  await prisma.restaurantSettings.update({ where: { restaurantId: ctx.restaurantId }, data: { logoUrl: null } });
  await deleteMediaBestEffort(previous.logoUrl);
  await recordAuditEntry(ctx, { entityType: "RestaurantSettings", entityId: ctx.restaurantId, action: "restaurant.logo_removed", previousValue: { logoUrl: previous.logoUrl }, newValue: { logoUrl: null }, category: "qr_menu" });
}
