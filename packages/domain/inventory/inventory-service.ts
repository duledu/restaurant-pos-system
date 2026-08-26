import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";

export type InventoryTrackingMethod = "NO_TRACKING" | "DIRECT_STOCK" | "RECIPE";

/**
 * P1.6: jedina autoritativna kapija za odluku o odbitku/dostupnosti —
 * zamenjuje raniju dinamičku trackStock+hasRecipe-postoji proveru
 * (getMenuItemIdsWithRecipes). Struktuurno garantuje "tačno jedan put":
 * kolona ne može istovremeno biti DIRECT_STOCK i RECIPE.
 *
 * P1.7: fires whenever the recorded quantity is nonzero — POSITIVE (real
 * physical goods that would silently stop being tracked) OR NEGATIVE (a
 * known, recorded discrepancy the manager should see before it becomes
 * invisible) — never just the positive case (audit §17: "Switch-away
 * warnings should correctly show positive or negative recorded quantities
 * if relevant").
 */
export class DirectStockStillPresentError extends Error {
  readonly remaining: Array<{ locationId: string; locationName: string; quantity: string; unit: string }>;

  constructor(itemName: string, remaining: Array<{ locationId: string; locationName: string; quantity: string; unit: string }>) {
    const lines = remaining.map((r) => `${r.locationName}: ${r.quantity} ${r.unit}`).join("\n");
    const anyNegative = remaining.some((r) => Number(r.quantity) < 0);
    const anyPositive = remaining.some((r) => Number(r.quantity) > 0);
    const description =
      anyNegative && anyPositive
        ? "i dalje ima zabeleženu zalihu gotovog proizvoda (na nekim lokacijama i negativnu — zabeležen manjak)"
        : anyNegative
          ? "ima zabeležen NEGATIVAN manjak gotovog proizvoda"
          : "i dalje ima zalihu gotovog proizvoda na stanju";
    super(
      `Artikal "${itemName}" ${description}:\n${lines}\nAko nastavite, praćenje ove zalihe se isključuje ali ISTORIJA (InventoryMovement) i tekuće stanje OSTAJU sačuvani, samo se više ne koriste za buduće prodaje. Potvrdite da želite da nastavite.`
    );
    this.name = "DirectStockStillPresentError";
    this.remaining = remaining;
  }
}

/**
 * Symmetric to DirectStockStillPresentError — fires on the OPPOSITE
 * direction (entering DIRECT_STOCK, from ANY previous method), when a
 * pre-existing InventoryItem row with a non-zero (positive OR negative —
 * P1.7: negative recorded stock is a real discrepancy worth surfacing too,
 * not just a positive quantity) quantity already exists for this MenuItem
 * (e.g. it was DIRECT_STOCK long ago, switched away, and is now being
 * switched back — or went DIRECT_STOCK -> RECIPE -> DIRECT_STOCK). That
 * frozen number was never verified as CURRENT physical reality and must
 * never be silently trusted again — see audit §19.
 */
export class StaleDirectStockQuantityError extends Error {
  readonly existing: Array<{ locationId: string; locationName: string; quantity: string; unit: string }>;

  constructor(itemName: string, existing: Array<{ locationId: string; locationName: string; quantity: string; unit: string }>) {
    const lines = existing.map((r) => `${r.locationName}: ${r.quantity} ${r.unit}`).join("\n");
    super(
      `Artikal "${itemName}" već ima zapis gotov-proizvod zalihe iz ranijeg perioda (možda zastareo ili negativan — zabeležen manjak):\n${lines}\nOva količina NIJE potvrđena kao trenutno tačna fizička zaliha i NEĆE se automatski koristiti. Ako nastavite, zaliha će biti nulirana (auditovano) i artikal će biti "nema na stanju" dok ne unesete stvarno fizičko stanje preko Zaliha. Potvrdite da želite da nastavite.`
    );
    this.name = "StaleDirectStockQuantityError";
    this.existing = existing;
  }
}

// ─── P1.7: NEGATIVE inventory (control/discrepancy detection, not a sales gate) ─
//
// TableCore inventory must NEVER block a normal restaurant sale because
// RECORDED stock is insufficient — the restaurant may physically have the
// goods while the manager simply hasn't entered today's delivery yet.
// InsufficientStockError/InsufficientIngredientStockError (which used to be
// thrown for exactly that case) are REMOVED — negative stock is now an
// intentionally valid, fully-auditable system state, not an error. See
// StockStatus below for the resulting NEGATIVE/OUT/LOW/OK precedence.

// ─── P3.3: jedinstvena definicija statusa zalihe ──────────────────────────────

export type StockStatus = "NEGATIVE" | "OUT" | "LOW" | "OK";

/**
 * JEDINA autoritativna definicija NEGATIVE/OUT/LOW/OK — ISTA granica kao
 * P1.1 Inventory UI (inventory-client.tsx stockStatus) i P2.3 Owner Control
 * Center (getStockAttention ispod, sada refaktorisano da koristi OVU
 * funkciju umesto sopstvene kopije logike — specifikacija #36). Nijedan
 * drugi sloj (React, order-service, dashboard) ne sme ponovo definisati
 * ovu granicu.
 *
 * P1.7: NEGATIVE (currentStock < 0) je najjači status — evidentiran manjak,
 * NIKAD tretiran kao obično "OUT" (currentStock == 0 tačno). Ni jedan ni
 * drugi status više ne blokira prodaju (vidi napomenu iznad) — ovo je čisto
 * informativna/alarmna klasifikacija.
 */
export function getInventoryStockStatus(currentStock: number, minimumStock: number | null): StockStatus {
  if (currentStock < 0) return "NEGATIVE";
  if (currentStock === 0) return "OUT";
  if (minimumStock != null && currentStock <= minimumStock) return "LOW";
  return "OK";
}

export interface MenuItemStockInfo {
  trackingEnabled: boolean;
  currentStock: string | null;
  minimumStock: string | null;
  stockStatus: StockStatus | null; // null kad trackingEnabled=false — status se ne primenjuje
}

/**
 * Batch-ovano stanje zaliha za dati skup MenuItem ID-jeva na JEDNOJ lokaciji
 * — TAČNO JEDAN upit bez obzira na broj artikala (specifikacija #16/#50/#73:
 * "ne pravi jedan zahtev po artiklu menija"). Interna kompoziciona funkcija
 * BEZ sopstvene permisione provere — pozivalac (menu-service.ts listMenuItems)
 * već proverava "menu.view" + requireLocationAccess PRE poziva. Ovo je
 * NAMERNO: konobar sme da vidi izvedeni status dostupnosti kroz meni bez
 * pune "inventory.view" permisije (specifikacija #44 — nova, uža
 * operativna vidljivost, ne puna administracija zaliha).
 */
export async function getStockStatusForMenuItems(
  restaurantId: string,
  locationId: string,
  menuItemIds: string[]
): Promise<Map<string, MenuItemStockInfo>> {
  const result = new Map<string, MenuItemStockInfo>();
  if (menuItemIds.length === 0) return result;

  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: menuItemIds }, restaurantId },
    select: { id: true, inventoryTrackingMethod: true, minimumStock: true },
  });
  const trackedIds = menuItems.filter((m) => m.inventoryTrackingMethod === "DIRECT_STOCK").map((m) => m.id);

  const invItems =
    trackedIds.length > 0
      ? await prisma.inventoryItem.findMany({
          where: { restaurantId, locationId, menuItemId: { in: trackedIds } },
          select: { menuItemId: true, currentStock: true },
        })
      : [];
  const stockByMenuItem = new Map(invItems.map((i) => [i.menuItemId, i.currentStock]));

  for (const mi of menuItems) {
    if (mi.inventoryTrackingMethod !== "DIRECT_STOCK") {
      result.set(mi.id, { trackingEnabled: false, currentStock: null, minimumStock: null, stockStatus: null });
      continue;
    }
    // Praćenje uključeno ali InventoryItem red ne postoji na OVOJ lokaciji
    // (npr. inicijalizovano samo za drugu lokaciju) — tretira se kao OUT,
    // isto kao validateAndDecrementInventoryInTx ("missing" grana ispod).
    const current = stockByMenuItem.get(mi.id);
    const currentNum = current != null ? Number(current) : 0;
    const minNum = mi.minimumStock != null ? Number(mi.minimumStock) : null;
    result.set(mi.id, {
      trackingEnabled: true,
      currentStock: current != null ? current.toString() : "0",
      minimumStock: mi.minimumStock != null ? mi.minimumStock.toString() : null,
      stockStatus: getInventoryStockStatus(currentNum, minNum),
    });
  }
  return result;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * `menuItem.hasRecipe` je DODATO (P1.3) uz postojeći `trackStock` — UI treba
 * da tretira stavku kao "efektivno praćenu" (Aktivno/OUT/LOW prikaz) samo
 * kad je `trackStock && !hasRecipe` (isti obrazac kao double-deduction
 * odbrana u validateAndDecrementInventoryInTx/assertStockAvailable ispod).
 * Ni ovo ni ijedna druga funkcija u ovom fajlu NIKAD ne briše InventoryItem/
 * InventoryMovement redove — istorija ostaje potpuno dostupna zauvek.
 */
export async function listInventory(ctx: AuthContext, locationId?: string) {
  requirePermission(ctx, "inventory.view");
  if (locationId) requireLocationAccess(ctx, locationId);
  const where = {
    restaurantId: ctx.restaurantId,
    locationId: locationId ?? { in: ctx.locationIds },
  };
  const items = await prisma.inventoryItem.findMany({
    where,
    include: {
      menuItem: {
        select: {
          id: true, name: true, slug: true, unit: true, quantity: true, isActive: true, minimumStock: true, trackStock: true, categoryId: true,
          inventoryTrackingMethod: true,
          inventoryCategoryId: true,
          inventoryCategory: { select: { id: true, name: true, parent: { select: { id: true, name: true } } } },
        },
      },
      location: { select: { id: true, name: true } },
    },
    orderBy: [{ location: { name: "asc" } }, { menuItem: { name: "asc" } }],
  });

  return items.map((item) => ({
    ...item,
    menuItem: { ...item.menuItem, hasRecipe: item.menuItem.inventoryTrackingMethod === "RECIPE" },
  }));
}

export interface StockAttentionItem {
  id: string;
  name: string;
  currentStock: string;
  minimumStock: number | null;
  unit: string;
  status: "negative" | "out" | "low";
}

export interface StockAttentionSummary {
  negativeStockCount: number;
  outOfStockCount: number;
  lowStockCount: number;
  worstItems: StockAttentionItem[];
}

const WORST_ITEMS_LIMIT = 5;

/**
 * P2.3 Owner Control Center — kompaktan pregled zaliha koje zahtevaju pažnju.
 * NAMERNO ponovo koristi listInventory (ISTA lista koju vidi Zalihe stranica)
 * i ISTU stockStatus definiciju kao inventory-client.tsx — ne izmišlja se
 * druga granica za Dashboard (specifikacija P2.3 #11). Vraća SAMO brojeve +
 * najgorih 5 stavki, ne kompletnu istoriju zaliha (#10/#26).
 *
 * P1.7: NEGATIVE (currentStock < 0) je NAJJAČI status — evidentiran manjak,
 * prikazuje se PRE običnog OUT-a (currentStock == 0) u worstItems, i ima
 * sopstveni brojač (negativeStockCount) tako da OWNER/ADMIN/MANAGER odmah
 * vidi koliko artikala ima stvarni zabeleženi manjak, ne samo "nema na
 * stanju". Ovo je čisto informativno — više NE blokira prodaju.
 */
export async function getStockAttention(ctx: AuthContext, locationId: string): Promise<StockAttentionSummary> {
  const items = await listInventory(ctx, locationId === "ALL" ? undefined : locationId);
  const tracked = items.filter((i) => i.menuItem.trackStock && !i.menuItem.hasRecipe);

  const classified = tracked.map((i) => {
    const current = Number(i.currentStock);
    const min = i.menuItem.minimumStock != null ? Number(i.menuItem.minimumStock) : null;
    const status = getInventoryStockStatus(current, min).toLowerCase() as "negative" | "out" | "low" | "ok";
    return { item: i, status, current, min };
  });

  const negativeItems = classified.filter((c) => c.status === "negative").sort((a, b) => a.current - b.current); // najveći manjak prvo
  const outItems = classified.filter((c) => c.status === "out");
  const lowItems = classified
    .filter((c) => c.status === "low")
    .sort((a, b) => (b.min! - b.current) - (a.min! - a.current)); // najveći deficit prvo

  const worstItems: StockAttentionItem[] = [...negativeItems, ...outItems, ...lowItems].slice(0, WORST_ITEMS_LIMIT).map((c) => ({
    id: c.item.id,
    name: c.item.menuItem.name,
    currentStock: c.item.currentStock.toString(),
    minimumStock: c.min,
    unit: c.item.unit,
    status: c.status as "negative" | "out" | "low",
  }));

  return { negativeStockCount: negativeItems.length, outOfStockCount: outItems.length, lowStockCount: lowItems.length, worstItems };
}

export async function getInventoryItem(ctx: AuthContext, id: string) {
  requirePermission(ctx, "inventory.view");
  const item = await prisma.inventoryItem.findFirst({
    where: { id, restaurantId: ctx.restaurantId },
    include: {
      menuItem: { select: { id: true, name: true, slug: true, unit: true, quantity: true, minimumStock: true, trackStock: true, inventoryTrackingMethod: true } },
      location: { select: { id: true, name: true } },
    },
  });
  if (!item) throw new Error("Stavka zalihe nije pronađena");
  requireLocationAccess(ctx, item.locationId);
  return item;
}

export async function getMovements(ctx: AuthContext, inventoryItemId: string, limit = 100) {
  requirePermission(ctx, "inventory.view");
  const item = await prisma.inventoryItem.findFirst({
    where: { id: inventoryItemId, restaurantId: ctx.restaurantId },
  });
  if (!item) throw new Error("Stavka zalihe nije pronađena");
  requireLocationAccess(ctx, item.locationId);

  const movements = await prisma.inventoryMovement.findMany({
    where: { inventoryItemId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const employeeIds = [...new Set(movements.flatMap((m) => (m.employeeId ? [m.employeeId] : [])))];
  const employees =
    employeeIds.length > 0
      ? await prisma.employee.findMany({
          where: { id: { in: employeeIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
  const nameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  return movements.map((m) => ({
    ...m,
    employeeName: m.employeeId ? (nameById.get(m.employeeId) ?? null) : null,
  }));
}

// ─── Setup ────────────────────────────────────────────────────────────────────

export async function initializeTracking(
  ctx: AuthContext,
  input: { menuItemId: string; locationId: string; initialStock: number; unit?: string }
) {
  requirePermission(ctx, "inventory.manage");

  const menuItem = await prisma.menuItem.findFirst({
    where: { id: input.menuItemId, ...scopeToRestaurant(ctx) },
  });
  if (!menuItem) throw new Error("Artikal nije pronađen");
  if (menuItem.inventoryTrackingMethod === "RECIPE") {
    throw new Error(
      `Artikal "${menuItem.name}" ima konfigurisan normativ (receptura od sirovina) — promenite metodu praćenja zaliha na "Gotov proizvod" pre inicijalizacije ove zalihe.`
    );
  }

  const location = await prisma.location.findFirst({
    where: { id: input.locationId, restaurantId: ctx.restaurantId },
  });
  if (!location) throw new Error("Lokacija nije pronađena");
  requireLocationAccess(ctx, location.id);

  if (input.initialStock < 0) throw new Error("Početno stanje ne može biti negativno");

  const unit = input.unit ?? menuItem.unit ?? "kom";

  const invItem = await prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryItem.findUnique({
      where: { locationId_menuItemId: { locationId: input.locationId, menuItemId: input.menuItemId } },
    });
    // Reconcile to the ENTERED value even when a row already exists — the
    // admin explicitly typed this number in the "inicijalizacija" form, it
    // must never be silently discarded (that would let a stale/frozen
    // number from a past DIRECT_STOCK period keep being treated as current
    // physical reality, exactly what the audit forbids). Same reconcile
    // pattern (before/after + auditable movement) as bulkSetOpeningStock.
    const before = existing ? Number(existing.currentStock) : 0;
    const after = input.initialStock;
    const delta = after - before;

    const item = existing
      ? await tx.inventoryItem.update({
          where: { id: existing.id },
          data: delta !== 0 ? { unit, currentStock: after } : { unit },
        })
      : await tx.inventoryItem.create({
          data: {
        restaurantId: ctx.restaurantId,
        locationId: input.locationId,
        menuItemId: input.menuItemId,
        currentStock: input.initialStock,
        unit,
          },
        });

    if (delta !== 0) {
      await tx.inventoryMovement.create({
        data: {
          restaurantId: ctx.restaurantId,
          locationId: input.locationId,
          menuItemId: input.menuItemId,
          inventoryItemId: item.id,
          type: existing ? "OPENING_STOCK" : "INITIAL",
          quantityDelta: delta,
          quantityBefore: before,
          quantityAfter: after,
          employeeId: ctx.employeeId,
          reason: existing ? "Ponovna inicijalizacija/korekcija zalihe pri (re)aktivaciji praćenja" : "Inicijalizacija praćenja zaliha",
        },
      });
    }

    await tx.menuItem.update({
      where: { id: input.menuItemId },
      data: { trackStock: true, inventoryTrackingMethod: "DIRECT_STOCK" },
    });

    return item;
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: input.menuItemId,
    action: "inventory.initialized",
    newValue: { initialStock: input.initialStock, locationId: input.locationId, unit },
  });

  return invItem;
}

/**
 * Legacy toggle (P1.1) — zadržan zbog postojećeg Zalihe UI checkbox-a i API
 * rute. Od P1.6 samo tanak omotač oko setInventoryTrackingMethod (DIRECT_STOCK
 * <-> NO_TRACKING), tako da postoji TAČNO JEDNA autoritativna implementacija
 * prelaska metode — ne dve paralelne.
 */
export async function setTrackingEnabled(
  ctx: AuthContext,
  menuItemId: string,
  enabled: boolean,
  options?: { confirmSwitchAwayFromDirectStock?: boolean; confirmReactivateDirectStock?: boolean }
) {
  return setInventoryTrackingMethod(ctx, menuItemId, enabled ? "DIRECT_STOCK" : "NO_TRACKING", options);
}

/**
 * P1.6: JEDINA autoritativna funkcija za promenu MenuItem.inventoryTrackingMethod.
 * Nikad ne briše InventoryItem/InventoryMovement/MenuItemIngredient/
 * IngredientMovement — ni istoriju, ni tekuće stanje. Nikad ne izmišlja
 * količinu (ne kreira InventoryItem/recepturu pri prelasku NA DIRECT_STOCK/
 * RECIPE — to ostaje eksplicitna, posebna akcija: initializeTracking odn.
 * addRecipeLine).
 *
 * Bezbednosno pravilo (jedino koje ova funkcija primenjuje): prelazak SA
 * DIRECT_STOCK na bilo šta drugo dok InventoryItem još ima currentStock > 0
 * na BILO KOJOJ lokaciji baca DirectStockStillPresentError osim ako je
 * `confirmSwitchAwayFromDirectStock: true` eksplicitno prosleđeno (UI ovo
 * koristi za potvrdni dijalog). Nijedan drugi pravac prelaska (RECIPE ->
 * bilo šta, NO_TRACKING -> bilo šta, bilo šta -> RECIPE/NO_TRACKING) nema
 * analognu proveru — sirovinsko stanje (IngredientStock) je DELJENO preko
 * više artikala, pa ne pripada pojedinačnom MenuItem-u na način koji bi
 * "upozorenje o gubitku" imalo smisla.
 */
export async function setInventoryTrackingMethod(
  ctx: AuthContext,
  menuItemId: string,
  method: InventoryTrackingMethod,
  options?: { confirmSwitchAwayFromDirectStock?: boolean; confirmReactivateDirectStock?: boolean }
) {
  requirePermission(ctx, "inventory.manage");
  const menuItem = await prisma.menuItem.findFirst({
    where: { id: menuItemId, ...scopeToRestaurant(ctx) },
  });
  if (!menuItem) throw new Error("Artikal nije pronađen");

  const previous = menuItem.inventoryTrackingMethod as InventoryTrackingMethod;
  if (previous === method) return menuItem; // no-op, ništa se ne menja niti audituje

  if (previous === "DIRECT_STOCK" && !options?.confirmSwitchAwayFromDirectStock) {
    const invItems = await prisma.inventoryItem.findMany({
      where: { restaurantId: ctx.restaurantId, menuItemId, currentStock: { not: 0 } },
      include: { location: { select: { id: true, name: true } } },
    });
    if (invItems.length > 0) {
      throw new DirectStockStillPresentError(
        menuItem.name,
        invItems.map((i) => ({
          locationId: i.locationId,
          locationName: i.location.name,
          quantity: i.currentStock.toString(),
          unit: i.unit,
        }))
      );
    }
  }

  // §19: entering DIRECT_STOCK (from ANY previous method) while an existing
  // InventoryItem row already carries a non-zero quantity — positive OR
  // negative (P1.7: a recorded deficit is just as much "not verified as
  // current physical reality" as a recorded surplus) — that number was
  // frozen from whenever this item last used finished-goods tracking and is
  // never auto-trusted again.
  let staleItems: Array<{ id: string; locationId: string; location: { id: string; name: string }; currentStock: Prisma.Decimal; unit: string }> = [];
  if (method === "DIRECT_STOCK") {
    staleItems = await prisma.inventoryItem.findMany({
      where: { restaurantId: ctx.restaurantId, menuItemId, currentStock: { not: 0 } },
      include: { location: { select: { id: true, name: true } } },
    });
    if (staleItems.length > 0 && !options?.confirmReactivateDirectStock) {
      throw new StaleDirectStockQuantityError(
        menuItem.name,
        staleItems.map((i) => ({
          locationId: i.locationId,
          locationName: i.location.name,
          quantity: i.currentStock.toString(),
          unit: i.unit,
        }))
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.menuItem.update({
      where: { id: menuItemId },
      data: { inventoryTrackingMethod: method, trackStock: method === "DIRECT_STOCK" },
    });

    // Confirmed reactivation with a stale nonzero row: never let that old
    // number go straight back to being sellable — zero it out (audited),
    // so the item is DIRECT_STOCK but OUT until the manager explicitly
    // re-enters the REAL physical count via Zalihe (initializeTracking/
    // receiveStock). This is a deliberate, auditable WRITE-OFF-style
    // reconciliation, never a silent mutation.
    for (const stale of staleItems) {
      const before = Number(stale.currentStock);
      await tx.inventoryItem.update({ where: { id: stale.id }, data: { currentStock: 0 } });
      await tx.inventoryMovement.create({
        data: {
          restaurantId: ctx.restaurantId,
          locationId: stale.locationId,
          menuItemId,
          inventoryItemId: stale.id,
          type: "ADJUSTMENT",
          quantityDelta: -before,
          quantityBefore: before,
          quantityAfter: 0,
          employeeId: ctx.employeeId,
          reason: "Nulirano pri ponovnoj aktivaciji direktnog praćenja zaliha — potrebna nova fizička provera pre prodaje",
        },
      });
    }

    return result;
  });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: menuItemId,
    action: "menu_item.inventory_tracking_method_changed",
    previousValue: { inventoryTrackingMethod: previous },
    newValue: { inventoryTrackingMethod: method },
  });

  return updated;
}

/**
 * `minimumStock: null` NAMERNO znači "prag nije podešen" (isključuje LOW
 * status u getInventoryStockStatus, nikad se ne tretira kao 0) — brisanje
 * praga je legitimna, eksplicitna operacija, ne slučajno stanje. Menja
 * ISKLJUČIVO MenuItem.minimumStock: nema InventoryMovement, ne dira
 * currentStock/price/isActive/isAvailable niti bilo šta drugo.
 */
export async function setMinimumStock(ctx: AuthContext, menuItemId: string, minimumStock: number | null) {
  requirePermission(ctx, "inventory.manage");
  if (minimumStock != null && minimumStock < 0) throw new Error("Minimalna zaliha ne može biti negativna");
  const menuItem = await prisma.menuItem.findFirst({
    where: { id: menuItemId, ...scopeToRestaurant(ctx) },
  });
  if (!menuItem) throw new Error("Artikal nije pronađen");

  await prisma.menuItem.update({ where: { id: menuItemId }, data: { minimumStock } });

  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: menuItemId,
    action: "inventory.minimum_stock_changed",
    previousValue: { minimumStock: menuItem.minimumStock != null ? Number(menuItem.minimumStock) : null },
    newValue: { minimumStock },
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export async function receiveStock(
  ctx: AuthContext,
  inventoryItemId: string,
  input: { quantity: number; reason?: string }
) {
  requirePermission(ctx, "inventory.manage");
  if (input.quantity <= 0) throw new Error("Količina mora biti pozitivna");

  const updated = await _applyDelta(ctx, inventoryItemId, input.quantity, "RECEIPT", {
    employeeId: ctx.employeeId,
    reason: input.reason ?? "Primanje robe",
  });

  await recordAuditEntry(ctx, {
    entityType: "InventoryItem",
    entityId: inventoryItemId,
    action: "inventory.receipt",
    newValue: { quantity: input.quantity, after: Number(updated.after) },
  });
  return updated;
}

export async function adjustStock(
  ctx: AuthContext,
  inventoryItemId: string,
  input: { delta: number; reason: string }
) {
  requirePermission(ctx, "inventory.manage");
  if (input.delta === 0) throw new Error("Delta korekcije ne može biti nula");
  if (!input.reason.trim()) throw new Error("Razlog korekcije je obavezan");

  const updated = await _applyDelta(ctx, inventoryItemId, input.delta, "ADJUSTMENT", {
    employeeId: ctx.employeeId,
    reason: input.reason,
  });

  await recordAuditEntry(ctx, {
    entityType: "InventoryItem",
    entityId: inventoryItemId,
    action: "inventory.adjustment",
    newValue: { delta: input.delta, reason: input.reason, after: Number(updated.after) },
  });
  return updated;
}

export async function writeOffStock(
  ctx: AuthContext,
  inventoryItemId: string,
  input: { quantity: number; reason: string }
) {
  requirePermission(ctx, "inventory.manage");
  if (input.quantity <= 0) throw new Error("Količina mora biti pozitivna");
  if (!input.reason.trim()) throw new Error("Razlog otpisa je obavezan");

  const updated = await _applyDelta(ctx, inventoryItemId, -input.quantity, "WRITE_OFF", {
    employeeId: ctx.employeeId,
    reason: input.reason,
  });

  await recordAuditEntry(ctx, {
    entityType: "InventoryItem",
    entityId: inventoryItemId,
    action: "inventory.write_off",
    newValue: { quantity: input.quantity, reason: input.reason, after: Number(updated.after) },
  });
  return updated;
}

// ─── Transactional sale decrement (called from billing inside $transaction) ───

/**
 * Atomically decrements stock for all DIRECT_STOCK items in a sale. Must be
 * called INSIDE an existing prisma.$transaction so the entire payment +
 * inventory change is a single atomic unit.
 *
 * P1.7: NEVER blocks/throws for insufficient (or missing) recorded stock —
 * "TableCore inventory must not block a normal sale because recorded stock
 * is insufficient" is now a core business rule (the restaurant may
 * physically have the goods; the record is just behind). A menuItemId with
 * no InventoryItem row yet at this location is atomically upserted into
 * existence starting from an implicit 0 (never "unlimited", never a block)
 * — see audit §12's DIRECT_STOCK-symmetric case. The only remaining failure
 * mode is a genuine database/system error, which still rolls back the
 * whole payment transaction exactly as before.
 *
 * Idempotent: if a SALE movement for paymentId+menuItemId already exists,
 * that item is skipped (safe for payment retries).
 *
 * Concurrency: `tx.inventoryItem.upsert` compiles to a single atomic
 * `INSERT ... ON CONFLICT (locationId, menuItemId) DO UPDATE` on
 * PostgreSQL — two concurrent transactions for the same (even
 * not-yet-existing) row serialize correctly via row-level locking, so both
 * legitimate concurrent sales succeed and are reflected exactly once each
 * (no lost update), the final stock can legitimately go negative.
 */
export async function validateAndDecrementInventoryInTx(
  tx: Prisma.TransactionClient,
  input: {
    paymentId: string;
    orderId: string;
    restaurantId: string;
    locationId: string;
    items: Array<{ menuItemId: string | null; quantity: number }>;
  }
): Promise<void> {
  const byItem = new Map<string, number>();
  for (const it of input.items) {
    if (!it.menuItemId) continue;
    byItem.set(it.menuItemId, (byItem.get(it.menuItemId) ?? 0) + it.quantity);
  }
  if (byItem.size === 0) return;

  const menuItemIds = [...byItem.keys()];

  // P1.6: inventoryTrackingMethod je JEDINI gate — struktuurno garantuje da
  // istovremeno nikad ne postoji i DIRECT_STOCK i RECIPE odbitak za isti
  // artikal (jedna kolona ne može imati dve vrednosti). RECIPE artikli su
  // isključivi domen validateAndDecrementIngredientsInTx-a (poziva se
  // odvojeno, u ISTOJ transakciji).
  const trackedMenuItems = await tx.menuItem.findMany({
    where: {
      id: { in: menuItemIds },
      restaurantId: input.restaurantId,
      inventoryTrackingMethod: "DIRECT_STOCK",
    },
    select: { id: true, unit: true },
  });
  if (trackedMenuItems.length === 0) return;

  for (const menuItem of trackedMenuItems) {
    const qty = byItem.get(menuItem.id) ?? 0;
    if (qty === 0) continue;

    // Idempotency: if a SALE movement for this payment+item already exists,
    // this is a payment retry — do not decrement again.
    const existingMovement = await tx.inventoryMovement.findUnique({
      where: { paymentId_menuItemId: { paymentId: input.paymentId, menuItemId: menuItem.id } },
    });
    if (existingMovement) continue;

    const invItem = await tx.inventoryItem.upsert({
      where: { locationId_menuItemId: { locationId: input.locationId, menuItemId: menuItem.id } },
      create: {
        restaurantId: input.restaurantId,
        locationId: input.locationId,
        menuItemId: menuItem.id,
        currentStock: -qty,
        unit: menuItem.unit ?? "kom",
      },
      update: { currentStock: { decrement: qty } },
    });

    // Derived, not read separately — mathematically correct regardless of
    // whether the row was just created or already existed, and immune to
    // any concurrent modification between an earlier SELECT and this
    // upsert (there isn't one — this IS the atomic operation).
    const afterStock = Number(invItem.currentStock);
    const beforeStock = afterStock + qty;

    await tx.inventoryMovement.create({
      data: {
        restaurantId: input.restaurantId,
        locationId: input.locationId,
        menuItemId: menuItem.id,
        inventoryItemId: invItem.id,
        type: "SALE",
        quantityDelta: -qty,
        quantityBefore: beforeStock,
        quantityAfter: afterStock,
        paymentId: input.paymentId,
        orderId: input.orderId,
        reason: "Prodaja",
      },
    });
  }
}

// ─── Bulk opening-stock initialization / reset (go-live workflow) ─────────────

export interface OpeningStockLine {
  menuItemId: string;
  quantity: number; // target ABSOLUTE stock (not a delta), must be >= 0
}

export interface OpeningStockResult {
  itemsAffected: number; // lines whose stock actually changed (movement created)
  itemsUnchanged: number; // lines already at the requested quantity — no movement
  results: Array<{ menuItemId: string; menuItemName: string; before: number; after: number; movementId: string | null }>;
}

/**
 * Bulk-reconciles current stock to a new target quantity per item, in ONE
 * atomic transaction — the "Postavi početno stanje zaliha" go-live action.
 * Gated by 'inventory.opening_stock' (OWNER/ADMIN only — deliberately
 * stricter than 'inventory.manage', which also covers MANAGER for routine
 * receive/adjust/write-off) because this can rewrite every tracked item's
 * stock in a single call.
 *
 * This NEVER deletes InventoryMovement history — it records one auditable
 * OPENING_STOCK movement per changed item (quantityBefore -> quantityAfter,
 * with the true delta), the same ledger-safe pattern already used by
 * receiveStock/adjustStock/writeOffStock above. A line already at the
 * requested quantity produces no movement (no-op noise avoided) but still
 * ensures trackStock=true, so listing "all tracked items" stays consistent.
 */
export async function bulkSetOpeningStock(
  ctx: AuthContext,
  input: { locationId: string; lines: OpeningStockLine[]; reason?: string }
): Promise<OpeningStockResult> {
  requirePermission(ctx, "inventory.opening_stock");

  if (input.lines.length === 0) throw new Error("Nema stavki za postavljanje početnog stanja");
  for (const line of input.lines) {
    if (line.quantity < 0) throw new Error("Količina ne može biti negativna");
  }

  const location = await prisma.location.findFirst({
    where: { id: input.locationId, restaurantId: ctx.restaurantId },
  });
  if (!location) throw new Error("Lokacija nije pronađena");
  requireLocationAccess(ctx, location.id);

  const menuItemIds = input.lines.map((l) => l.menuItemId);
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: menuItemIds }, restaurantId: ctx.restaurantId },
    select: { id: true, name: true, unit: true, inventoryTrackingMethod: true },
  });
  const menuItemById = new Map(menuItems.map((m) => [m.id, m]));
  const missing = menuItemIds.filter((id) => !menuItemById.has(id));
  if (missing.length > 0) {
    throw new Error(`Artikli ne pripadaju ovom restoranu ili ne postoje: ${missing.join(", ")}`);
  }

  // P1.6: this function force-sets inventoryTrackingMethod=DIRECT_STOCK on
  // every line it touches (see below) — reject the WHOLE batch outright if
  // any line targets a RECIPE-governed item, rather than silently
  // reactivating the exact dual-stock state addRecipeLine's atomic
  // transition exists to prevent. Same "reject the whole batch" precedent
  // as the "foreign menu item" check above — the client-side candidate
  // lists (InitModal/OpeningStockModal) already exclude these, so this is a
  // server-side backstop, not the primary UX.
  const recipeGoverned = menuItems.filter((m) => m.inventoryTrackingMethod === "RECIPE").map((m) => m.id);
  if (recipeGoverned.length > 0) {
    const names = recipeGoverned.map((id) => menuItemById.get(id)?.name ?? id).join(", ");
    throw new Error(
      `Sledeći artikli imaju konfigurisan normativ i ne mogu se inicijalizovati kao gotov-artikal zaliha: ${names}`
    );
  }

  const reason = input.reason?.trim() || "Postavljanje početnog stanja zaliha";

  const results = await prisma.$transaction(
    async (tx) => {
      const out: OpeningStockResult["results"] = [];
      for (const line of input.lines) {
        const menuItem = menuItemById.get(line.menuItemId)!;
        const existing = await tx.inventoryItem.findUnique({
          where: { locationId_menuItemId: { locationId: input.locationId, menuItemId: line.menuItemId } },
        });

        const before = existing ? Number(existing.currentStock) : 0;
        const after = line.quantity;
        const delta = after - before;

        let inventoryItemId: string;
        if (existing) {
          inventoryItemId = existing.id;
          if (delta !== 0) {
            await tx.inventoryItem.update({ where: { id: existing.id }, data: { currentStock: after } });
          }
        } else {
          const created = await tx.inventoryItem.create({
            data: {
              restaurantId: ctx.restaurantId,
              locationId: input.locationId,
              menuItemId: line.menuItemId,
              currentStock: after,
              unit: menuItem.unit ?? "kom",
            },
          });
          inventoryItemId = created.id;
        }

        let movementId: string | null = null;
        if (delta !== 0) {
          const mov = await tx.inventoryMovement.create({
            data: {
              restaurantId: ctx.restaurantId,
              locationId: input.locationId,
              menuItemId: line.menuItemId,
              inventoryItemId,
              type: "OPENING_STOCK",
              quantityDelta: delta,
              quantityBefore: before,
              quantityAfter: after,
              employeeId: ctx.employeeId,
              reason,
            },
          });
          movementId = mov.id;
        }

        await tx.menuItem.update({ where: { id: line.menuItemId }, data: { trackStock: true, inventoryTrackingMethod: "DIRECT_STOCK" } });

        out.push({ menuItemId: line.menuItemId, menuItemName: menuItem.name, before, after, movementId });
      }
      return out;
    },
    { timeout: 30_000, maxWait: 10_000 } // bulk operations can touch 100+ items — default 5s timeout is too tight
  );

  const changed = results.filter((r) => r.movementId !== null);

  await recordAuditEntry(ctx, {
    entityType: "InventoryItem",
    entityId: input.locationId,
    action: "inventory.opening_stock_set",
    newValue: {
      locationId: input.locationId,
      reason,
      itemsAffected: changed.length,
      itemsUnchanged: results.length - changed.length,
      changes: changed.map((r) => ({ menuItemId: r.menuItemId, menuItemName: r.menuItemName, before: r.before, after: r.after })),
    },
  });

  return { itemsAffected: changed.length, itemsUnchanged: results.length - changed.length, results };
}

/**
 * Convenience wrapper: reconciles every CURRENTLY TRACKED item at a location
 * to zero — the "Postavi sve na 0" go-live action. Reuses
 * bulkSetOpeningStock (same atomicity, same OPENING_STOCK ledger movement,
 * same audit entry) rather than a separate code path. Never deletes
 * InventoryItem/InventoryMovement rows — only reconciles currentStock to 0
 * with an auditable movement, exactly like any other opening-stock change.
 */
export async function bulkZeroOpeningStock(ctx: AuthContext, input: { locationId: string }): Promise<OpeningStockResult> {
  requirePermission(ctx, "inventory.opening_stock");

  const location = await prisma.location.findFirst({
    where: { id: input.locationId, restaurantId: ctx.restaurantId },
  });
  if (!location) throw new Error("Lokacija nije pronađena");
  requireLocationAccess(ctx, location.id);

  const tracked = await prisma.inventoryItem.findMany({
    where: { restaurantId: ctx.restaurantId, locationId: input.locationId },
    select: { menuItemId: true },
  });
  if (tracked.length === 0) {
    return { itemsAffected: 0, itemsUnchanged: 0, results: [] };
  }

  // P1.6: never reconcile a RECIPE-governed item's frozen historical stock —
  // it's no longer sellable finished-goods, only a preserved historical
  // record. "Postavi sve na 0" must skip it entirely, not silently zero it.
  const methodByMenuItem = await prisma.menuItem.findMany({
    where: { id: { in: tracked.map((t) => t.menuItemId) } },
    select: { id: true, inventoryTrackingMethod: true },
  });
  const recipeMenuItemIds = new Set(
    methodByMenuItem.filter((m) => m.inventoryTrackingMethod === "RECIPE").map((m) => m.id)
  );
  const directStockOnly = tracked.filter((t) => !recipeMenuItemIds.has(t.menuItemId));
  if (directStockOnly.length === 0) {
    return { itemsAffected: 0, itemsUnchanged: 0, results: [] };
  }

  return bulkSetOpeningStock(ctx, {
    locationId: input.locationId,
    lines: directStockOnly.map((t) => ({ menuItemId: t.menuItemId, quantity: 0 })),
    reason: "Resetovanje zaliha na 0 pre unosa stvarnog početnog stanja",
  });
}

// ─── Standalone sale decrement (non-billing contexts) ─────────────────────────

/**
 * Standalone version of sale decrement — starts its own transaction.
 * Kept for backward compatibility and non-billing use cases. P1.7: never
 * throws for insufficient/missing stock — see validateAndDecrementInventoryInTx.
 */
export async function decrementOnSale(input: {
  paymentId: string;
  orderId: string;
  restaurantId: string;
  locationId: string;
  items: Array<{ menuItemId: string | null; quantity: number }>;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await validateAndDecrementInventoryInTx(tx, input);
  });
}

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * P1.7: this manual-operation guard is DELIBERATELY NOT the same rule as
 * SALE deduction (validateAndDecrementInventoryInTx above, which never
 * blocks). A manual RECEIPT (delta >= 0) always succeeds regardless of
 * starting balance — even from an already-negative stock (audit §18: "must
 * continue to work when current stock is negative"; §10's reconciliation
 * example, e.g. -0.050 + RECEIPT 2.000 = 1.950, requires this). A manual
 * ADJUSTMENT/WRITE_OFF (delta < 0) still cannot push stock BELOW its
 * current value into more negative territory — that guardrail against a
 * fat-finger typo is a deliberately separate, narrower concern than "can a
 * sale be blocked", and audit §11 ("never auto-correct negative stock")
 * only forbids the SYSTEM inventing a correction, not a human's own
 * intentional, reasoned adjustment being sanity-checked.
 */
async function _applyDelta(
  ctx: AuthContext,
  inventoryItemId: string,
  delta: number,
  type: "RECEIPT" | "ADJUSTMENT" | "WRITE_OFF",
  meta: { employeeId: string; reason: string }
) {
  const accessibleItem = await prisma.inventoryItem.findFirst({
    where: {
      id: inventoryItemId,
      restaurantId: ctx.restaurantId,
      locationId: { in: ctx.locationIds },
    },
    select: { id: true },
  });
  if (!accessibleItem) throw new Error("Stavka zalihe nije pronađena");

  return prisma.$transaction(async (tx) => {
    type UpdatedRow = {
      id: string;
      restaurantId: string;
      locationId: string;
      menuItemId: string;
      currentStock: string;
    };
    const rows = await tx.$queryRaw<UpdatedRow[]>`
      UPDATE inventory_items
      SET "currentStock" = "currentStock" + ${delta}::numeric
      WHERE id = ${inventoryItemId}
        AND "restaurantId" = ${ctx.restaurantId}
        AND (${delta}::numeric >= 0 OR "currentStock" >= -${delta}::numeric)
      RETURNING id, "restaurantId", "locationId", "menuItemId", "currentStock"
    `;
    const updated = rows[0];
    if (!updated) {
      const item = await tx.inventoryItem.findFirst({
        where: { id: inventoryItemId, restaurantId: ctx.restaurantId },
        select: { currentStock: true },
      });
      if (!item) throw new Error("Stavka zalihe nije pronađena");
      throw new Error(
        `Promena bi dovela do negativnog stanja (trenutno: ${item.currentStock}). Maksimalno umanjenje: ${item.currentStock}.`
      );
    }

    const after = Number(updated.currentStock);
    const before = after - delta;
    const mov = await tx.inventoryMovement.create({
      data: {
        restaurantId: ctx.restaurantId,
        locationId: updated.locationId,
        menuItemId: updated.menuItemId,
        inventoryItemId,
        type,
        quantityDelta: delta,
        quantityBefore: before,
        quantityAfter: after,
        employeeId: meta.employeeId,
        reason: meta.reason,
      },
    });
    return { item: updated, movement: mov, before, after };
  });
}
