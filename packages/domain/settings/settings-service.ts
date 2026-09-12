/**
 * Faza 6 — podešavanja restorana (adresa, PIB, tekst na računu) i
 * konfiguracija štampača. Čitanje je dozvoljeno svakom autentifikovanom
 * zaposlenom (potrebno je npr. da bi se ispravno renderovao kupčev račun
 * bez obzira ko štampa) — izmena zahteva "settings.manage".
 */
import { prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { printerConfigSchema } from "@rcs/shared";
import { lockPrintLocation, stationPolicy, suppressAutomaticJobs } from "../printing/print-policy";
import { recordAuditEntry } from "../audit/audit-service";
import { buildCacheKey, getOrSet, cacheDel } from "../cache/cache-client";

const SETTINGS_MANAGE = "settings.manage";

// P0/perf: SAMO opšta podešavanja restorana (adresa/PIB/tekst na računu) —
// NAMERNO ne i konfiguracija štampača ispod (PrinterConfig) dok se ne
// završi QZ Tray integracija koja tu konfiguraciju uskoro menja; keširanje
// nečega što se aktivno redizajnira bi samo dodalo zbunjujuću zastarelost.
const SETTINGS_CACHE_TTL_SECONDS = 300;

function settingsCacheKey(restaurantId: string): string {
  return buildCacheKey(restaurantId, "settings");
}

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
  return getOrSet({
    key: settingsCacheKey(ctx.restaurantId),
    ttlSeconds: SETTINGS_CACHE_TTL_SECONDS,
    loader: async () => {
      const row = await prisma.restaurantSettings.findUnique({ where: { restaurantId: ctx.restaurantId } });
      return row ?? DEFAULTS(ctx.restaurantId);
    },
  });
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
  const updated = await prisma.restaurantSettings.upsert({
    where: { restaurantId: ctx.restaurantId },
    create: { restaurantId: ctx.restaurantId, ...input },
    update: input,
  });
  await cacheDel(settingsCacheKey(ctx.restaurantId));
  return updated;
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
  requireLocationAccess(ctx, locationId);
  return prisma.printerConfig.findMany({
    where: { locationId, ...scopeToRestaurant(ctx) },
    orderBy: { station: "asc" },
  });
}

/** Jedna konfiguracija po (lokacija, stanica) — vidi @@unique u schema.prisma. */
export async function upsertPrinterConfig(ctx: AuthContext, input: PrinterConfigInput) {
  requirePermission(ctx, SETTINGS_MANAGE);
  const data = printerConfigSchema.parse(input);
  requireLocationAccess(ctx, data.locationId);
  return prisma.$transaction(async (tx) => {
    await lockPrintLocation(tx, ctx.restaurantId, data.locationId);
    const previous = await stationPolicy(tx, ctx.restaurantId, data.locationId, data.station);
    const enabled = data.isEnabled && data.autoPrint;
    const automaticSince = enabled && !(previous.isEnabled && previous.autoPrint) ? new Date() : previous.automaticSince;
    const updated = await tx.printerConfig.upsert({
      where: { locationId_station: { locationId: data.locationId, station: data.station } },
      create: { ...data, restaurantId: ctx.restaurantId, automaticSince },
      update: { ...data, automaticSince },
    });
    if (!enabled) await suppressAutomaticJobs(tx, ctx.restaurantId, data.locationId, data.station);
    await recordAuditEntry(ctx, { entityType: "PrinterConfig", entityId: updated.id, action: "printer.policy_updated",
      previousValue: previous, newValue: updated, locationId: data.locationId }, tx);
    return updated;
  }, { timeout: 15000 });
}

export async function deletePrinterConfig(ctx: AuthContext, id: string): Promise<void> {
  requirePermission(ctx, SETTINGS_MANAGE);
  const config = await prisma.printerConfig.findFirst({ where: { id, ...scopeToRestaurant(ctx) } });
  if (!config) return;
  requireLocationAccess(ctx, config.locationId);
  // Retain a disabled policy tombstone: deleting would restore the legacy ON default.
  await upsertPrinterConfig(ctx, { ...config, isEnabled: false, autoPrint: false });
}

/**
 * Interno čitanje (BEZ permission gate-a) za sam štamparski pipeline —
 * npr. KONOBAR koji šalje porudžbinu mora dobiti tačnu širinu papira te
 * stanice da bi se tiket ispravno zamrznuo u PrintJob.content, a nema (i ne
 * treba mu) "settings.manage". NIKAD se ne izlaže direktno kroz API rutu —
 * samo iz print-service.ts dispatch* funkcija. Nepostojeći red = razumni
 * podrazumevani (80mm, omogućeno) — restoran koji nikad nije otvorio
 * podešavanja štampača i dalje dobija ispravnu, radnu konfiguraciju.
 */
export async function getPrinterConfigForDispatch(
  restaurantId: string,
  locationId: string,
  station: "KITCHEN" | "BAR" | "RECEIPT"
): Promise<{ paperWidthMm: number; isEnabled: boolean }> {
  const row = await prisma.printerConfig.findUnique({ where: { locationId_station: { locationId, station } } });
  if (!row || row.restaurantId !== restaurantId) return { paperWidthMm: 80, isEnabled: true };
  return { paperWidthMm: row.paperWidthMm, isEnabled: row.isEnabled };
}
