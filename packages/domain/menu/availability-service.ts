/**
 * Kuhinja/Šank OPERATIVNA dostupnost ("NIJE DOSTUPNO") — vidi opširnu
 * napomenu uz MenuItemAvailability u schema.prisma za pun kontekst i
 * konkurentske/dizajn odluke. Ovaj fajl je JEDINI autoritativni izvor za:
 *
 *  - da li je artikal TRENUTNO tvrdo blokiran za NOVO naručivanje na datoj
 *    lokaciji (order-service.ts addItem/updateItem/submitOrder pozivaju
 *    getBlockedAvailability ispod)
 *  - RBAC ko sme da menja dostupnost (KITCHEN samo KITCHEN/KITCHEN_AND_BAR
 *    artikle, BAR samo BAR/KITCHEN_AND_BAR, OWNER/ADMIN/MANAGER sve, WAITER
 *    nikad — vidi assertAvailabilityAccess)
 *
 * POTPUNO NEZAVISNO od zalihe (InventoryItem/IngredientStock) — nula/
 * negativna zaliha ostaje SAMO upozorenje (getInventoryStockStatus), nikad
 * ne prolazi kroz ovaj fajl niti utiče na njega.
 */
import { prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, ForbiddenError, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import {
  AVAILABILITY_REASON_LABELS,
  type AvailabilityReasonCode,
  type SetMenuItemAvailabilityInput,
} from "@rcs/shared";

const AVAILABILITY_MANAGE = "production.manage"; // isti obrazac kao production-service.ts — vidi seed.ts (KITCHEN/BAR/OWNER/ADMIN/MANAGER, nikad WAITER)
const AVAILABILITY_VIEW = "menu.view"; // waiter mora VIDETI stanje (crveno "NIJE DOSTUPNO") bez ijedne production permisije

type Station = "KITCHEN" | "BAR";

/**
 * Ista granica kao production-service.ts assertStationAccess (namerno
 * DUPLIRANO ovde, ne uvoženo iz production modula — dostupnost NIJE KDS
 * tiket-status, to je zaseban, samo strukturno paralelan koncept; uvoženje
 * bi nepotrebno spojilo dva nezavisna domena). KITCHEN_AND_BAR artikal sme
 * da menja BILO KOJA od dve stanice — kvar na jednoj strani i dalje čini
 * artikal nepripremljivim u celini.
 */
function assertAvailabilityAccess(ctx: AuthContext, preparationStation: string): void {
  const isManagement = ctx.roles.some((r) => ["OWNER", "ADMIN", "MANAGER"].includes(r));
  if (isManagement) return;

  const stationsAllowed: Station[] =
    preparationStation === "KITCHEN_AND_BAR" ? ["KITCHEN", "BAR"] : preparationStation === "BAR" ? ["BAR"] : ["KITCHEN"];
  const hasAccess = stationsAllowed.some((s) => ctx.roles.includes(s));
  if (!hasAccess) {
    throw new ForbiddenError("Nemaš ovlašćenje da menjaš dostupnost ovog artikla");
  }
}

export interface AvailabilityRow {
  menuItemId: string;
  name: string;
  preparationStation: string;
  isAvailable: boolean;
  reasonCode: AvailabilityReasonCode | null;
  reasonLabel: string | null;
  note: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
}

/**
 * Kuhinja/Šank dostupnost ekran — SVI aktivni artikli za tu stanicu na toj
 * lokaciji (uključujući KITCHEN_AND_BAR na oba ekrana), sa trenutnim
 * override stanjem ako postoji (LEFT JOIN semantika preko dve odvojene
 * upita — Prisma nema pravi LEFT JOIN, pa se override mapira po
 * menuItemId iz drugog upita, isto kao getStockStatusForMenuItems).
 */
export async function listAvailabilityForStation(ctx: AuthContext, locationId: string, station: Station) {
  requirePermission(ctx, AVAILABILITY_MANAGE);
  requireLocationAccess(ctx, locationId);
  assertAvailabilityAccess(ctx, station); // menadžment vidi oba; KITCHEN/BAR samo svoju

  const menuItems = await prisma.menuItem.findMany({
    where: {
      ...scopeToRestaurant(ctx),
      deletedAt: null,
      isActive: true,
      preparationStation: station === "KITCHEN" ? { in: ["KITCHEN", "KITCHEN_AND_BAR"] } : { in: ["BAR", "KITCHEN_AND_BAR"] },
    },
    select: { id: true, name: true, preparationStation: true },
    orderBy: { name: "asc" },
  });
  if (menuItems.length === 0) return [];

  const overrides = await prisma.menuItemAvailability.findMany({
    where: { locationId, menuItemId: { in: menuItems.map((m) => m.id) } },
  });
  const overrideByItem = new Map(overrides.map((o) => [o.menuItemId, o]));

  const employeeIds = [...new Set(overrides.map((o) => o.updatedBy))];
  const employees =
    employeeIds.length > 0
      ? await prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
  const nameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  const rows: AvailabilityRow[] = menuItems.map((mi) => {
    const override = overrideByItem.get(mi.id);
    return {
      menuItemId: mi.id,
      name: mi.name,
      preparationStation: mi.preparationStation,
      isAvailable: !override, // odsustvo reda = dostupan
      reasonCode: (override?.reasonCode as AvailabilityReasonCode | undefined) ?? null,
      reasonLabel: override?.reasonCode ? AVAILABILITY_REASON_LABELS[override.reasonCode as AvailabilityReasonCode] : null,
      note: override?.note ?? null,
      updatedByName: override ? (nameById.get(override.updatedBy) ?? "?") : null,
      updatedAt: override?.updatedAt.toISOString() ?? null,
    };
  });
  return rows;
}

/**
 * Postavlja/uklanja per-lokacijsku dostupnost — JEDINA autoritativna mutacija
 * za MenuItemAvailability. Re-omogućavanje BRIŠE red (nikad ne ostavlja
 * zastareo isAvailable=true red — vidi napomenu uz model u schema.prisma).
 * Auditovano u SVAKOM slučaju (i onemogućavanje i ponovno omogućavanje).
 */
export async function setAvailability(ctx: AuthContext, input: SetMenuItemAvailabilityInput) {
  requirePermission(ctx, AVAILABILITY_MANAGE);
  requireLocationAccess(ctx, input.locationId);

  const menuItem = await prisma.menuItem.findFirst({
    where: { id: input.menuItemId, ...scopeToRestaurant(ctx), deletedAt: null },
    select: { id: true, name: true, preparationStation: true },
  });
  if (!menuItem) throw new Error("Artikal nije pronađen");
  assertAvailabilityAccess(ctx, menuItem.preparationStation);

  const existing = await prisma.menuItemAvailability.findUnique({
    where: { locationId_menuItemId: { locationId: input.locationId, menuItemId: input.menuItemId } },
  });
  const previousState = existing
    ? { isAvailable: false, reasonCode: existing.reasonCode, note: existing.note }
    : { isAvailable: true, reasonCode: null, note: null };

  if (input.isAvailable) {
    if (existing) {
      await prisma.menuItemAvailability.delete({ where: { id: existing.id } });
    }
  } else {
    await prisma.menuItemAvailability.upsert({
      where: { locationId_menuItemId: { locationId: input.locationId, menuItemId: input.menuItemId } },
      create: {
        restaurantId: ctx.restaurantId,
        locationId: input.locationId,
        menuItemId: input.menuItemId,
        isAvailable: false,
        reasonCode: input.reasonCode,
        note: input.note?.trim() || null,
        updatedBy: ctx.employeeId,
      },
      update: {
        reasonCode: input.reasonCode,
        note: input.note?.trim() || null,
        updatedBy: ctx.employeeId,
      },
    });
  }

  await recordAuditEntry(ctx, {
    entityType: "MenuItemAvailability",
    entityId: input.menuItemId,
    action: input.isAvailable ? "menu_item_availability.enabled" : "menu_item_availability.disabled",
    previousValue: previousState,
    newValue: { isAvailable: input.isAvailable, reasonCode: input.reasonCode ?? null, note: input.note?.trim() || null },
    locationId: input.locationId,
  });

  return { menuItemId: input.menuItemId, locationId: input.locationId, isAvailable: input.isAvailable };
}

export interface BlockedAvailabilityInfo {
  reasonCode: AvailabilityReasonCode;
  reasonLabel: string;
}

/**
 * Batch lookup — koje od datih menuItemId su TRENUTNO tvrdo blokirane na
 * datoj lokaciji. Interna kompoziciona funkcija BEZ sopstvene permisione
 * provere (pozivalac je order-service.ts, koji je već proverao operatora) —
 * isti obrazac kao getStockStatusForMenuItems.
 */
export async function getBlockedAvailability(
  restaurantId: string,
  locationId: string,
  menuItemIds: string[]
): Promise<Map<string, BlockedAvailabilityInfo>> {
  const result = new Map<string, BlockedAvailabilityInfo>();
  if (menuItemIds.length === 0) return result;

  const overrides = await prisma.menuItemAvailability.findMany({
    where: { restaurantId, locationId, menuItemId: { in: menuItemIds } },
    select: { menuItemId: true, reasonCode: true },
  });
  for (const o of overrides) {
    const reasonCode = (o.reasonCode as AvailabilityReasonCode) ?? "DRUGO";
    result.set(o.menuItemId, { reasonCode, reasonLabel: AVAILABILITY_REASON_LABELS[reasonCode] });
  }
  return result;
}

export interface MenuItemAvailabilityStatus {
  isAvailable: boolean;
  reasonCode: AvailabilityReasonCode | null;
  reasonLabel: string | null;
}

/**
 * Waiter-facing batch lookup za meni ekran — isti obrazac kao
 * getStockStatusForMenuItems, spojeno u menu-service.listMenuItems ispod
 * kao `item.availability`. Vraća stanje za SVAKI traženi menuItemId (uvek
 * `isAvailable: true` kad reda nema — vidi napomenu o "odsustvo = dostupan").
 */
export async function getAvailabilityForMenuItems(
  restaurantId: string,
  locationId: string,
  menuItemIds: string[]
): Promise<Map<string, MenuItemAvailabilityStatus>> {
  const blocked = await getBlockedAvailability(restaurantId, locationId, menuItemIds);
  const result = new Map<string, MenuItemAvailabilityStatus>();
  for (const id of menuItemIds) {
    const b = blocked.get(id);
    result.set(id, b ? { isAvailable: false, reasonCode: b.reasonCode, reasonLabel: b.reasonLabel } : { isAvailable: true, reasonCode: null, reasonLabel: null });
  }
  return result;
}
