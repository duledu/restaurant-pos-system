/**
 * BRANDED QR MENU V1.
 *
 * SINGLE SOURCE OF TRUTH: this module NEVER stores menu content of its own
 * — `getPublicMenu` reads the exact same MenuCategory/MenuItem rows every
 * other part of TableCore reads (packages/domain/menu/menu-service.ts).
 * There is no QRMenuItem/QRCategory model. When staff edit a price/name/
 * image inside TableCore, the guest menu reflects it immediately (no
 * separate publish step, no sync job).
 *
 * SECURITY: `getPublicMenu` is the ONLY entry point a public, unauthenticated
 * route may call. It takes a `slug` (never a restaurantId) and resolves the
 * restaurant context itself, server-side — a guest can never supply a
 * restaurantId and see another restaurant's data. The returned payload is a
 * hand-built projection (see PublicMenuPayload) — never a raw Prisma
 * object — so no internal id, cost, employee, inventory, audit, or
 * permission data can ever leak through this path, even by accident from a
 * future schema change (adding a field to MenuItem does NOT automatically
 * expose it here).
 *
 * THEME: one engine, many identities (spec's core requirement) — the same
 * resolveQrMenuTheme (packages/shared/qr-menu-theme.ts) and the same public
 * menu React components render every restaurant; only the stored
 * QrMenuSettings row differs. The Admin live preview reuses this exact
 * function/payload shape too — never a second, hand-maintained preview
 * implementation.
 */
import { randomUUID } from "crypto";
import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import type { UpdateQrMenuSettingsInput } from "@rcs/shared";
import type { QrThemePreset, QrTypographyPreset, QrCardStyle, QrImageShape } from "@rcs/shared";

const QR_MENU_VIEW = "qr_menu.view";
const QR_MENU_MANAGE = "qr_menu.manage";

interface QrMenuSettingsView {
  restaurantId: string;
  tagline: string | null;
  coverImageUrl: string | null;
  themePreset: QrThemePreset;
  accentColor: string | null;
  typographyPreset: QrTypographyPreset;
  cardStyle: QrCardStyle;
  imageShape: QrImageShape;
  isPublished: boolean;
}

const DEFAULTS = (restaurantId: string): QrMenuSettingsView => ({
  restaurantId,
  tagline: null,
  coverImageUrl: null,
  themePreset: "WARM",
  accentColor: null,
  typographyPreset: "MODERN",
  cardStyle: "BALANCED",
  imageShape: "ROUNDED",
  isPublished: true,
});

/** Same lazy-row convention as settings-service.ts's getRestaurantSettings — no row yet = sensible defaults, never a backfill migration. */
export async function getQrMenuSettings(ctx: AuthContext): Promise<QrMenuSettingsView & { slug: string | null; restaurantName: string; logoUrl: string | null }> {
  requirePermission(ctx, QR_MENU_VIEW);
  const [row, restaurant, restaurantSettings] = await Promise.all([
    prisma.qrMenuSettings.findUnique({ where: { restaurantId: ctx.restaurantId } }),
    prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId }, select: { slug: true, name: true } }),
    prisma.restaurantSettings.findUnique({ where: { restaurantId: ctx.restaurantId }, select: { logoUrl: true } }),
  ]);
  return { ...(row ?? DEFAULTS(ctx.restaurantId)), slug: restaurant.slug, restaurantName: restaurant.name, logoUrl: restaurantSettings?.logoUrl ?? null };
}

export async function updateQrMenuSettings(ctx: AuthContext, input: UpdateQrMenuSettingsInput): Promise<QrMenuSettingsView> {
  requirePermission(ctx, QR_MENU_MANAGE);
  const previous = await prisma.qrMenuSettings.findUnique({ where: { restaurantId: ctx.restaurantId } });
  const updated = await prisma.qrMenuSettings.upsert({
    where: { restaurantId: ctx.restaurantId },
    create: { restaurantId: ctx.restaurantId, ...input, updatedBy: ctx.employeeId },
    update: { ...input, updatedBy: ctx.employeeId },
  });
  await recordAuditEntry(ctx, {
    entityType: "QrMenuSettings",
    entityId: ctx.restaurantId,
    action: "qr_menu.settings_updated",
    previousValue: previous ? { ...previous } : DEFAULTS(ctx.restaurantId),
    newValue: { ...updated },
    category: "qr_menu",
  });
  return updated;
}

export async function updateRestaurantSlug(ctx: AuthContext, slug: string): Promise<string> {
  requirePermission(ctx, QR_MENU_MANAGE);
  const taken = await prisma.restaurant.findFirst({ where: { slug, id: { not: ctx.restaurantId } }, select: { id: true } });
  if (taken) throw new Error("Ova adresa menija je već zauzeta — izaberi drugu");
  const previous = await prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId }, select: { slug: true } });
  if (previous.slug === slug) return slug;
  const updated = await prisma.restaurant.update({ where: { id: ctx.restaurantId }, data: { slug }, select: { slug: true } });
  await recordAuditEntry(ctx, {
    entityType: "Restaurant",
    entityId: ctx.restaurantId,
    action: "restaurant.slug_updated",
    previousValue: { slug: previous.slug },
    newValue: { slug: updated.slug },
    category: "qr_menu",
  });
  return updated.slug!;
}

/** Admin "QR kodovi" screen — every table, grouped by floor, with its QR token if one was already generated (client builds the actual QR image/URL — see apps/web). */
export async function listTablesForQr(ctx: AuthContext) {
  requirePermission(ctx, QR_MENU_VIEW);
  return prisma.floor.findMany({
    where: scopeToRestaurant(ctx),
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      name: true,
      tables: {
        where: { isActive: true },
        orderBy: { label: "asc" },
        select: { id: true, label: true, publicQrToken: true },
      },
    },
  });
}

/** Lazily generates (never re-generates) a table's public QR token. A random UUID — same randomness source already trusted for every primary key in this schema, deliberately not a bespoke crypto scheme (spec: don't over-engineer). */
export async function getOrCreateTableQrToken(ctx: AuthContext, tableId: string): Promise<string> {
  requirePermission(ctx, QR_MENU_MANAGE);
  const table = await prisma.restaurantTable.findFirst({
    where: { id: tableId, floor: scopeToRestaurant(ctx) },
    select: { id: true, label: true, publicQrToken: true, floor: { select: { locationId: true } } },
  });
  if (!table) throw new Error("Sto nije pronađen");
  requireLocationAccess(ctx, table.floor.locationId);
  if (table.publicQrToken) return table.publicQrToken;

  const token = randomUUID();
  await prisma.restaurantTable.update({ where: { id: table.id }, data: { publicQrToken: token } });
  await recordAuditEntry(ctx, {
    entityType: "RestaurantTable",
    entityId: table.id,
    action: "restaurant_table.qr_token_generated",
    newValue: { tableLabel: table.label },
    locationId: table.floor.locationId,
    category: "qr_menu",
  });
  return token;
}

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC — no AuthContext, no permission check. Called only from the public
// /m/[slug] route. See module doc comment for the security rationale.
// ─────────────────────────────────────────────────────────────────────────

export interface PublicMenuItem {
  id: string;
  name: string;
  description: string | null;
  price: string;
  imageUrl: string | null;
  isAvailable: boolean;
  preparationStation: "KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE";
}
export interface PublicMenuCategory {
  id: string;
  name: string;
  type: "FOOD" | "DRINK";
  items: PublicMenuItem[];
}
export interface PublicMenuPayload {
  restaurant: { name: string; tagline: string | null; logoUrl: string | null; coverImageUrl: string | null };
  theme: { themePreset: QrThemePreset; accentColor: string | null; typographyPreset: QrTypographyPreset; cardStyle: QrCardStyle; imageShape: QrImageShape };
  table: { label: string } | null;
  categories: PublicMenuCategory[];
}

/**
 * Returns null for: unknown slug, non-ACTIVE restaurant (SUSPENDED/
 * ARCHIVED), or isPublished=false — the public route turns any of these
 * into an identical, generic 404. Never reveals WHICH reason applied (a
 * guest — or anyone probing slugs — cannot distinguish "doesn't exist" from
 * "exists but is unpublished/suspended").
 */
export async function getPublicMenu(slug: string, tableToken?: string | null): Promise<PublicMenuPayload | null> {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) return null;

  const restaurant = await prisma.restaurant.findFirst({
    where: { slug: normalizedSlug, status: "ACTIVE" },
    select: { id: true, name: true },
  });
  if (!restaurant) return null;

  const [qrSettings, restaurantSettings, categories, table] = await Promise.all([
    prisma.qrMenuSettings.findUnique({ where: { restaurantId: restaurant.id } }),
    prisma.restaurantSettings.findUnique({ where: { restaurantId: restaurant.id }, select: { logoUrl: true } }),
    prisma.menuCategory.findMany({
      where: { restaurantId: restaurant.id, isActive: true },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        type: true,
        items: {
          where: { restaurantId: restaurant.id, isActive: true },
          orderBy: { sortOrder: "asc" },
          select: { id: true, name: true, description: true, price: true, imageUrl: true, isAvailable: true, preparationStation: true },
        },
      },
    }),
    tableToken
      ? prisma.restaurantTable.findFirst({ where: { publicQrToken: tableToken, floor: { restaurantId: restaurant.id } }, select: { label: true } })
      : Promise.resolve(null),
  ]);

  if (qrSettings && !qrSettings.isPublished) return null;

  return {
    restaurant: {
      name: restaurant.name,
      tagline: qrSettings?.tagline ?? null,
      logoUrl: restaurantSettings?.logoUrl ?? null,
      coverImageUrl: qrSettings?.coverImageUrl ?? null,
    },
    theme: {
      themePreset: qrSettings?.themePreset ?? DEFAULTS(restaurant.id).themePreset,
      accentColor: qrSettings?.accentColor ?? null,
      typographyPreset: qrSettings?.typographyPreset ?? DEFAULTS(restaurant.id).typographyPreset,
      cardStyle: qrSettings?.cardStyle ?? DEFAULTS(restaurant.id).cardStyle,
      imageShape: qrSettings?.imageShape ?? DEFAULTS(restaurant.id).imageShape,
    },
    table: table ? { label: table.label } : null,
    categories: categories
      .filter((c) => c.items.length > 0)
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        items: c.items.map((i) => ({ id: i.id, name: i.name, description: i.description, price: i.price.toString(), imageUrl: i.imageUrl, isAvailable: i.isAvailable, preparationStation: i.preparationStation })),
      })),
  };
}
