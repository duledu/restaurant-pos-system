import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class InsufficientStockError extends Error {
  readonly stockItems: Array<{ name: string; available: number; required: number }>;

  constructor(items: Array<{ name: string; available: number; required: number }>) {
    const lines = items
      .map((i) => `${i.name}\n  Dostupno: ${i.available}, Potrebno: ${i.required}`)
      .join("\n");
    super(`Nema dovoljno zaliha za završetak prodaje:\n${lines}`);
    this.name = "InsufficientStockError";
    this.stockItems = items;
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function listInventory(ctx: AuthContext, locationId?: string) {
  requirePermission(ctx, "inventory.view");
  if (locationId) requireLocationAccess(ctx, locationId);
  const where = {
    restaurantId: ctx.restaurantId,
    locationId: locationId ?? { in: ctx.locationIds },
  };
  return prisma.inventoryItem.findMany({
    where,
    include: {
      menuItem: {
        select: { id: true, name: true, slug: true, unit: true, quantity: true, isActive: true, minimumStock: true, trackStock: true, categoryId: true },
      },
      location: { select: { id: true, name: true } },
    },
    orderBy: [{ location: { name: "asc" } }, { menuItem: { name: "asc" } }],
  });
}

export interface StockAttentionItem {
  id: string;
  name: string;
  currentStock: string;
  minimumStock: number | null;
  unit: string;
  status: "out" | "low";
}

export interface StockAttentionSummary {
  outOfStockCount: number;
  lowStockCount: number;
  worstItems: StockAttentionItem[];
}

const WORST_ITEMS_LIMIT = 5;

/**
 * P2.3 Owner Control Center — kompaktan pregled zaliha koje zahtevaju pažnju.
 * NAMERNO ponovo koristi listInventory (ISTA lista koju vidi Zalihe stranica)
 * i ISTU stockStatus definiciju kao inventory-client.tsx (P1.1: OUT kad je
 * currentStock <= 0; LOW kad je currentStock > 0 i <= minimumStock) — ne
 * izmišlja se druga granica za Dashboard (specifikacija P2.3 #11). Vraća
 * SAMO brojeve + najgorih 5 stavki, ne kompletnu istoriju zaliha (#10/#26).
 */
export async function getStockAttention(ctx: AuthContext, locationId: string): Promise<StockAttentionSummary> {
  const items = await listInventory(ctx, locationId === "ALL" ? undefined : locationId);
  const tracked = items.filter((i) => i.menuItem.trackStock);

  const classified = tracked.map((i) => {
    const current = Number(i.currentStock);
    const min = i.menuItem.minimumStock != null ? Number(i.menuItem.minimumStock) : null;
    const status: "out" | "low" | "ok" = current <= 0 ? "out" : min != null && current <= min ? "low" : "ok";
    return { item: i, status, current, min };
  });

  const outItems = classified.filter((c) => c.status === "out").sort((a, b) => a.current - b.current);
  const lowItems = classified
    .filter((c) => c.status === "low")
    .sort((a, b) => (b.min! - b.current) - (a.min! - a.current)); // najveći deficit prvo

  const worstItems: StockAttentionItem[] = [...outItems, ...lowItems].slice(0, WORST_ITEMS_LIMIT).map((c) => ({
    id: c.item.id,
    name: c.item.menuItem.name,
    currentStock: c.item.currentStock.toString(),
    minimumStock: c.min,
    unit: c.item.unit,
    status: c.status as "out" | "low",
  }));

  return { outOfStockCount: outItems.length, lowStockCount: lowItems.length, worstItems };
}

export async function getInventoryItem(ctx: AuthContext, id: string) {
  requirePermission(ctx, "inventory.view");
  const item = await prisma.inventoryItem.findFirst({
    where: { id, restaurantId: ctx.restaurantId },
    include: {
      menuItem: { select: { id: true, name: true, slug: true, unit: true, quantity: true, minimumStock: true, trackStock: true } },
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
    const item = existing
      ? await tx.inventoryItem.update({ where: { id: existing.id }, data: { unit } })
      : await tx.inventoryItem.create({
          data: {
        restaurantId: ctx.restaurantId,
        locationId: input.locationId,
        menuItemId: input.menuItemId,
        currentStock: input.initialStock,
        unit,
          },
        });

    if (!existing && input.initialStock > 0) {
      await tx.inventoryMovement.create({
        data: {
          restaurantId: ctx.restaurantId,
          locationId: input.locationId,
          menuItemId: input.menuItemId,
          inventoryItemId: item.id,
          type: "INITIAL",
          quantityDelta: input.initialStock,
          quantityBefore: 0,
          quantityAfter: input.initialStock,
          employeeId: ctx.employeeId,
          reason: "Inicijalizacija praćenja zaliha",
        },
      });
    }

    await tx.menuItem.update({
      where: { id: input.menuItemId },
      data: { trackStock: true },
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

export async function setTrackingEnabled(ctx: AuthContext, menuItemId: string, enabled: boolean) {
  requirePermission(ctx, "inventory.manage");
  const menuItem = await prisma.menuItem.findFirst({
    where: { id: menuItemId, ...scopeToRestaurant(ctx) },
  });
  if (!menuItem) throw new Error("Artikal nije pronađen");
  await prisma.menuItem.update({ where: { id: menuItemId }, data: { trackStock: enabled } });
  await recordAuditEntry(ctx, {
    entityType: "MenuItem",
    entityId: menuItemId,
    action: enabled ? "inventory.tracking_enabled" : "inventory.tracking_disabled",
    newValue: { trackStock: enabled },
  });
}

export async function setMinimumStock(ctx: AuthContext, menuItemId: string, minimumStock: number) {
  requirePermission(ctx, "inventory.manage");
  if (minimumStock < 0) throw new Error("Minimalna zaliha ne može biti negativna");
  const menuItem = await prisma.menuItem.findFirst({
    where: { id: menuItemId, ...scopeToRestaurant(ctx) },
  });
  if (!menuItem) throw new Error("Artikal nije pronađen");
  await prisma.menuItem.update({ where: { id: menuItemId }, data: { minimumStock } });
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
 * Atomically validates and decrements stock for all tracked items in a sale.
 * Must be called INSIDE an existing prisma.$transaction so the entire
 * payment + inventory change is a single atomic unit.
 *
 * Throws InsufficientStockError if any tracked item lacks sufficient stock.
 * The caller's transaction will roll back on error — payment is never persisted.
 *
 * Idempotent: if a SALE movement for paymentId+menuItemId already exists,
 * that item is skipped (safe for payment retries).
 *
 * Concurrency: uses an atomic conditional UPDATE (WHERE currentStock >= qty)
 * so two concurrent transactions for the same item serialize correctly via
 * PostgreSQL's row-level locking — the second sees the post-commit stock.
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

  const trackedMenuItems = await tx.menuItem.findMany({
    where: {
      id: { in: menuItemIds },
      restaurantId: input.restaurantId,
      trackStock: true,
    },
    select: { id: true, name: true },
  });
  if (trackedMenuItems.length === 0) return;

  const invItems = await tx.inventoryItem.findMany({
    where: {
      restaurantId: input.restaurantId,
      locationId: input.locationId,
      menuItemId: { in: trackedMenuItems.map((item) => item.id) },
    },
    select: {
      id: true,
      menuItemId: true,
      currentStock: true,
      menuItem: { select: { name: true } },
    },
  });

  const inventoryByMenuItem = new Map(invItems.map((item) => [item.menuItemId, item]));
  const missing = trackedMenuItems.filter((item) => !inventoryByMenuItem.has(item.id));
  if (missing.length > 0) {
    throw new InsufficientStockError(
      missing.map((item) => ({
        name: item.name,
        available: 0,
        required: byItem.get(item.id) ?? 0,
      }))
    );
  }

  for (const invItem of invItems) {
    const qty = byItem.get(invItem.menuItemId) ?? 0;
    if (qty === 0) continue;

    // Idempotency: if a SALE movement for this payment+item already exists,
    // this is a payment retry — do not decrement again.
    const existing = await tx.inventoryMovement.findUnique({
      where: { paymentId_menuItemId: { paymentId: input.paymentId, menuItemId: invItem.menuItemId } },
    });
    if (existing) continue;

    // Atomic conditional decrement. READ COMMITTED isolation means the WHERE
    // clause sees the latest committed value, so concurrent transactions on the
    // same row serialize correctly: if A decrements first and B then evaluates
    // the WHERE, B sees A's committed result and fails if stock is insufficient.
    type Row = { currentStock: string };
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE inventory_items
      SET "currentStock" = "currentStock" - ${qty}::numeric
      WHERE id = ${invItem.id}
        AND "currentStock" >= ${qty}::numeric
      RETURNING "currentStock"
    `;

    if (rows.length === 0) {
      const current = await tx.inventoryItem.findUnique({
        where: { id: invItem.id },
        select: { currentStock: true },
      });
      throw new InsufficientStockError([{
        name: invItem.menuItem.name,
        available: Number(current?.currentStock ?? 0),
        required: qty,
      }]);
    }

    const afterStock = Number(rows[0].currentStock);
    const beforeStock = afterStock + qty;

    await tx.inventoryMovement.create({
      data: {
        restaurantId: input.restaurantId,
        locationId: input.locationId,
        menuItemId: invItem.menuItemId,
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
    select: { id: true, name: true, unit: true },
  });
  const menuItemById = new Map(menuItems.map((m) => [m.id, m]));
  const missing = menuItemIds.filter((id) => !menuItemById.has(id));
  if (missing.length > 0) {
    throw new Error(`Artikli ne pripadaju ovom restoranu ili ne postoje: ${missing.join(", ")}`);
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

        await tx.menuItem.update({ where: { id: line.menuItemId }, data: { trackStock: true } });

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

  return bulkSetOpeningStock(ctx, {
    locationId: input.locationId,
    lines: tracked.map((t) => ({ menuItemId: t.menuItemId, quantity: 0 })),
    reason: "Resetovanje zaliha na 0 pre unosa stvarnog početnog stanja",
  });
}

// ─── Standalone sale decrement (non-billing contexts) ─────────────────────────

/**
 * Standalone version of sale decrement — starts its own transaction.
 * Kept for backward compatibility and non-billing use cases.
 * Throws InsufficientStockError on insufficient stock.
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
