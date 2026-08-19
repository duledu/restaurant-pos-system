import { prisma, Prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant, type AuthContext } from "@rcs/auth";
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
  const where = {
    restaurantId: ctx.restaurantId,
    ...(locationId ? { locationId } : {}),
  };
  return prisma.inventoryItem.findMany({
    where,
    include: {
      menuItem: {
        select: { id: true, name: true, slug: true, unit: true, quantity: true, isActive: true, minimumStock: true, trackStock: true },
      },
      location: { select: { id: true, name: true } },
    },
    orderBy: [{ location: { name: "asc" } }, { menuItem: { name: "asc" } }],
  });
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
  return item;
}

export async function getMovements(ctx: AuthContext, inventoryItemId: string, limit = 100) {
  requirePermission(ctx, "inventory.view");
  const item = await prisma.inventoryItem.findFirst({
    where: { id: inventoryItemId, restaurantId: ctx.restaurantId },
  });
  if (!item) throw new Error("Stavka zalihe nije pronađena");
  return prisma.inventoryMovement.findMany({
    where: { inventoryItemId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
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
