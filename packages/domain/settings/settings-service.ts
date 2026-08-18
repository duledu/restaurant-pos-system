/**
 * Faza 6 — podešavanja restorana (adresa, PIB, tekst na računu) i
 * konfiguracija štampača. Čitanje je dozvoljeno svakom autentifikovanom
 * zaposlenom (potrebno je npr. da bi se ispravno renderovao kupčev račun
 * bez obzira ko štampa) — izmena zahteva "settings.manage".
 */
import { prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant, type AuthContext } from "@rcs/auth";

const SETTINGS_MANAGE = "settings.manage";

export interface RestaurantSettingsView {
  restaurantId: string;
  address: string | null;
  phone: string | null;
  taxIdNumber: string | null;
  receiptFooterText: string | null;
  receiptLegalNote: string | null;
  logoUrl: string | null;
}

const DEFAULTS = (restaurantId: string): RestaurantSettingsView => ({
  restaurantId,
  address: null,
  phone: null,
  taxIdNumber: null,
  receiptFooterText: null,
  receiptLegalNote: null,
  logoUrl: null,
});

/**
 * Vraća podešavanja restorana, ili razumne default vrednosti ako red još
 * ne postoji (lenjo kreiran tek pri prvom čuvanju — nema backfill migracije).
 */
export async function getRestaurantSettings(ctx: Pick<AuthContext, "restaurantId">): Promise<RestaurantSettingsView> {
  const row = await prisma.restaurantSettings.findUnique({ where: { restaurantId: ctx.restaurantId } });
  return row ?? DEFAULTS(ctx.restaurantId);
}

export interface UpdateRestaurantSettingsInput {
  address?: string | null;
  phone?: string | null;
  taxIdNumber?: string | null;
  receiptFooterText?: string | null;
  receiptLegalNote?: string | null;
  logoUrl?: string | null;
}

export async function updateRestaurantSettings(
  ctx: AuthContext,
  input: UpdateRestaurantSettingsInput
): Promise<RestaurantSettingsView> {
  requirePermission(ctx, SETTINGS_MANAGE);
  return prisma.restaurantSettings.upsert({
    where: { restaurantId: ctx.restaurantId },
    create: { restaurantId: ctx.restaurantId, ...input },
    update: input,
  });
}

export interface PrinterConfigInput {
  locationId: string;
  station: "KITCHEN" | "BAR" | "RECEIPT";
  name: string;
  printerType?: "BROWSER" | "ESC_POS_LAN" | "NETWORK";
  paperWidthMm?: number;
  isEnabled?: boolean;
  autoPrint?: boolean;
  copies?: number;
  ipAddress?: string | null;
  port?: number | null;
}

export async function listPrinterConfigs(ctx: AuthContext, locationId: string) {
  requirePermission(ctx, SETTINGS_MANAGE);
  return prisma.printerConfig.findMany({
    where: { locationId, ...scopeToRestaurant(ctx) },
    orderBy: { station: "asc" },
  });
}

/** Jedna konfiguracija po (lokacija, stanica) — vidi @@unique u schema.prisma. */
export async function upsertPrinterConfig(ctx: AuthContext, input: PrinterConfigInput) {
  requirePermission(ctx, SETTINGS_MANAGE);
  return prisma.printerConfig.upsert({
    where: { locationId_station: { locationId: input.locationId, station: input.station } },
    create: { restaurantId: ctx.restaurantId, ...input },
    update: input,
  });
}

export async function deletePrinterConfig(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, SETTINGS_MANAGE);
  await prisma.printerConfig.deleteMany({ where: { id, ...scopeToRestaurant(ctx) } });
}
