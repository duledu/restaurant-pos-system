/**
 * IMAGE MANAGEMENT V1 — one shared upload/replace/remove pipeline for the
 * three image roles TableCore's public QR Menu already knows how to render
 * (MenuItem.imageUrl, QrMenuSettings.coverImageUrl, RestaurantSettings.logoUrl).
 * No new database fields — existing fields are reused, existing SSRF-safe
 * plain-<img> public rendering is untouched.
 *
 * STORAGE: Vercel Blob (`@vercel/blob`), chosen because this app deploys on
 * Vercel and no other object-storage infrastructure existed in the repo
 * (confirmed via audit before implementing). Objects are public-read
 * (guest menu is unauthenticated) and keyed under `restaurants/{restaurantId}/...`
 * so tenant ownership is legible from the key itself; Vercel Blob's
 * `addRandomSuffix` (default true) makes every key collision-proof without
 * this module having to invent its own uniqueness scheme.
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
 */
import sharp from "sharp";
import { put, del } from "@vercel/blob";
import { prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";

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
}

// Different roles need different treatment (spec: menu item = thumbnail/
// detail scale, hero = larger landscape asset, logo = smaller identity
// asset with transparency preserved). WebP everywhere except the logo,
// which stays PNG so a transparent source (the common case for a brand
// mark) never gets flattened onto a background color.
const ROLE_PROCESSING: Record<ImageAssetRole, RoleProcessing> = {
  MENU_ITEM_IMAGE: { resize: { width: 1000, height: 1000 }, format: "webp", extension: "webp" },
  QR_HERO_IMAGE: { resize: { width: 1920, height: 1080 }, format: "webp", extension: "webp" },
  RESTAURANT_LOGO: { resize: { width: 512, height: 512 }, format: "png", extension: "png" },
};

async function processImage(buffer: Buffer, role: ImageAssetRole): Promise<Buffer> {
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

/** Uploads + processes, but does NOT touch the database or delete anything old — the three role-specific functions below own that (each has a different target table/ownership check). */
async function uploadProcessed(upload: RawUpload, role: ImageAssetRole, keyPrefix: string): Promise<string> {
  validateRawUpload(upload);
  const processed = await processImage(upload.buffer, role);
  const { extension, format } = ROLE_PROCESSING[role];
  const blob = await put(`${keyPrefix}.${extension}`, processed, {
    access: "public",
    contentType: format === "webp" ? "image/webp" : "image/png",
    addRandomSuffix: true,
  });
  return blob.url;
}

/** Best-effort delete of a previously-stored blob — failure here must never break the restaurant's menu (spec Phase 7). Only ever called with a URL this module itself produced. */
async function deleteBlobBestEffort(url: string | null): Promise<void> {
  if (!url?.includes(".public.blob.vercel-storage.com/")) return; // never attempt to delete a URL we didn't issue (e.g. a legacy admin-pasted URL)
  try {
    await del(url);
  } catch (err) {
    console.error("[image-service] best-effort blob delete failed", { url, err });
  }
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
  const url = await uploadProcessed(upload, "MENU_ITEM_IMAGE", `restaurants/${ctx.restaurantId}/menu-items/${itemId}/photo`);
  await prisma.menuItem.update({ where: { id: itemId }, data: { imageUrl: url } });
  await deleteBlobBestEffort(item.imageUrl); // only after the new URL is safely persisted (safe-replace ordering)
  await recordAuditEntry(ctx, { entityType: "MenuItem", entityId: itemId, action: "menu_item.image_uploaded", previousValue: { imageUrl: item.imageUrl }, newValue: { imageUrl: url } });
  return url;
}

export async function removeMenuItemImage(ctx: AuthContext, itemId: string): Promise<void> {
  requirePermission(ctx, MENU_MANAGE);
  const item = await getOwnedMenuItem(ctx, itemId);
  if (!item.imageUrl) return;
  await prisma.menuItem.update({ where: { id: itemId }, data: { imageUrl: null } });
  await deleteBlobBestEffort(item.imageUrl);
  await recordAuditEntry(ctx, { entityType: "MenuItem", entityId: itemId, action: "menu_item.image_removed", previousValue: { imageUrl: item.imageUrl }, newValue: { imageUrl: null } });
}

// ── QR_HERO_IMAGE (QrMenuSettings.coverImageUrl) ────────────────────────

export async function uploadQrHeroImage(ctx: AuthContext, upload: RawUpload): Promise<string> {
  requirePermission(ctx, QR_MENU_MANAGE);
  const previous = await prisma.qrMenuSettings.findUnique({ where: { restaurantId: ctx.restaurantId }, select: { coverImageUrl: true } });
  const url = await uploadProcessed(upload, "QR_HERO_IMAGE", `restaurants/${ctx.restaurantId}/qr/hero`);
  await prisma.qrMenuSettings.upsert({
    where: { restaurantId: ctx.restaurantId },
    create: { restaurantId: ctx.restaurantId, coverImageUrl: url, updatedBy: ctx.employeeId },
    update: { coverImageUrl: url, updatedBy: ctx.employeeId },
  });
  await deleteBlobBestEffort(previous?.coverImageUrl ?? null);
  await recordAuditEntry(ctx, { entityType: "QrMenuSettings", entityId: ctx.restaurantId, action: "qr_menu.hero_uploaded", previousValue: { coverImageUrl: previous?.coverImageUrl ?? null }, newValue: { coverImageUrl: url }, category: "qr_menu" });
  return url;
}

export async function removeQrHeroImage(ctx: AuthContext): Promise<void> {
  requirePermission(ctx, QR_MENU_MANAGE);
  const previous = await prisma.qrMenuSettings.findUnique({ where: { restaurantId: ctx.restaurantId }, select: { coverImageUrl: true } });
  if (!previous?.coverImageUrl) return;
  await prisma.qrMenuSettings.update({ where: { restaurantId: ctx.restaurantId }, data: { coverImageUrl: null, updatedBy: ctx.employeeId } });
  await deleteBlobBestEffort(previous.coverImageUrl);
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
  const url = await uploadProcessed(upload, "RESTAURANT_LOGO", `restaurants/${ctx.restaurantId}/qr/logo`);
  await prisma.restaurantSettings.upsert({
    where: { restaurantId: ctx.restaurantId },
    create: { restaurantId: ctx.restaurantId, logoUrl: url },
    update: { logoUrl: url },
  });
  await deleteBlobBestEffort(previous?.logoUrl ?? null);
  await recordAuditEntry(ctx, { entityType: "RestaurantSettings", entityId: ctx.restaurantId, action: "restaurant.logo_uploaded", previousValue: { logoUrl: previous?.logoUrl ?? null }, newValue: { logoUrl: url }, category: "qr_menu" });
  return url;
}

export async function removeRestaurantLogo(ctx: AuthContext): Promise<void> {
  requirePermission(ctx, QR_MENU_MANAGE);
  const previous = await prisma.restaurantSettings.findUnique({ where: { restaurantId: ctx.restaurantId }, select: { logoUrl: true } });
  if (!previous?.logoUrl) return;
  await prisma.restaurantSettings.update({ where: { restaurantId: ctx.restaurantId }, data: { logoUrl: null } });
  await deleteBlobBestEffort(previous.logoUrl);
  await recordAuditEntry(ctx, { entityType: "RestaurantSettings", entityId: ctx.restaurantId, action: "restaurant.logo_removed", previousValue: { logoUrl: previous.logoUrl }, newValue: { logoUrl: null }, category: "qr_menu" });
}
