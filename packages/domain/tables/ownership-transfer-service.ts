/**
 * SHIFT HANDOVER V1 — Table Ownership Transfer Engine.
 *
 * ONE authoritative, server-side mechanism for reassigning "who is
 * currently responsible for an open table" — reused by Shift Handover,
 * individual table transfer, multi-table handoff, and manager forced
 * transfer. Not a new ownership/authorization model: `Order.openedBy` is
 * ALREADY the sole ownership signal in the whole system (used for display
 * in table-service.ts's listTables(), and for DRAFT-only authorization in
 * order-access.ts's requireDraftOwnership) — this engine only changes WHO
 * that field points to, atomically and with a full audit trail. It never
 * touches KDS dispatch, PrintJob creation, or Payment/Receipt records —
 * all of those key off orderId/restaurantId/locationId, never off
 * "current owner" (confirmed by audit before writing this file).
 *
 * AUTHORIZATION (deliberately unchanged from the existing invariant in
 * order-access.ts/transfer-service.ts): SUBMITTED+ orders already have NO
 * per-waiter ownership restriction — any WAITER with location access can
 * already modify/pay/void/transfer them. This engine follows the exact
 * same rule for self-service claim/handoff (requireOrderOperator), and
 * gates the FORCED path on isOrderManager — it does not introduce a
 * stricter boundary than what already exists.
 *
 * CONFIRMATION: no "PIN re-confirmation for a sensitive action" pattern
 * exists anywhere in this codebase (confirmed by audit) — building one
 * here would be exactly the "parallel Employee/PIN system" the spec
 * forbids. The incoming waiter's own authenticated session (the existing
 * per-device PIN-bound login / Quick Lock re-auth) IS the confirmation,
 * identical in spirit to how every other order action already works
 * without a second PIN prompt.
 *
 * CONCURRENCY: each table's transfer is its own atomic conditional
 * UPDATE (`updateMany` with `openedBy: expectedPreviousOwnerId` in the
 * WHERE clause, checked via `.count`) — the exact same idiom already
 * proven in this codebase (inventura-service.ts's stale-line guard,
 * transfer-service.ts's per-item `updateMany` guards). A bulk transfer
 * (multiple tables) is deliberately NOT one all-or-nothing transaction
 * across unrelated Order rows — each table is logically independent, so
 * one table being stale must not block the others from succeeding. This
 * is the documented semantics per spec Section 16: every line resolves
 * unambiguously (succeeded or explicitly rejected-with-reason), never a
 * silently-skipped or partially-unclear state.
 */
import { prisma, Prisma } from "@rcs/db";
import { requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { ssePublisher } from "../realtime/sse-publisher";
import { requireOrderOperator, isOrderManager } from "../orders/order-access";
import { naturalCompare } from "@rcs/shared";

export type TransferReason = "SHIFT_HANDOVER" | "MANUAL_TABLE_TRANSFER" | "MANAGER_FORCED_TRANSFER";

const OPEN_ORDER_STATUSES = { notIn: ["COMPLETED", "CANCELLED"] as Array<"COMPLETED" | "CANCELLED"> };

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

export class StaleOwnershipError extends Error {
  constructor(
    public readonly tableLabel: string,
    public readonly actualOwnerName: string | null
  ) {
    super(
      actualOwnerName
        ? `Sto "${tableLabel}" je upravo preuzeo/la ${actualOwnerName} — osveži prikaz.`
        : `Sto "${tableLabel}" više nije dostupan za preuzimanje — osveži prikaz.`
    );
  }
}

async function employeeName(employeeId: string): Promise<string> {
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { firstName: true, lastName: true } });
  return e ? `${e.firstName} ${e.lastName}` : "Nepoznat zaposleni";
}

async function loadOpenOrdersForLocation(ctx: AuthContext, locationId: string) {
  return prisma.order.findMany({
    where: { restaurantId: ctx.restaurantId, locationId, status: OPEN_ORDER_STATUSES },
    select: {
      id: true,
      openedBy: true,
      status: true,
      table: { select: { id: true, label: true } },
      items: { select: { id: true }, where: { status: { not: "CANCELLED" } } },
    },
  });
}

type OpenTableOrder = Awaited<ReturnType<typeof loadOpenOrdersForLocation>>[number];

async function namesFor(employeeIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
  return new Map(rows.map((r) => [r.id, `${r.firstName} ${r.lastName}`]));
}

export interface TakeoverGroup {
  employeeId: string;
  employeeName: string;
  tables: Array<{ tableId: string; tableLabel: string; orderId: string; itemCount: number; status: string }>;
}

/**
 * "PREUZIMANJE STOLOVA" — open tables belonging to OTHER waiters, grouped
 * by current owner. Excludes the caller's own tables (those belong on the
 * "PREDAJA" screen instead).
 */
export async function listAvailableTablesForTakeover(ctx: AuthContext, locationId: string): Promise<TakeoverGroup[]> {
  requireOrderOperator(ctx);
  requireLocationAccess(ctx, locationId);

  const orders = (await loadOpenOrdersForLocation(ctx, locationId)).filter((o) => o.openedBy !== ctx.employeeId);
  const names = await namesFor(orders.map((o) => o.openedBy));

  const groups = new Map<string, TakeoverGroup>();
  for (const o of orders) {
    if (!groups.has(o.openedBy)) {
      groups.set(o.openedBy, { employeeId: o.openedBy, employeeName: names.get(o.openedBy) ?? "Nepoznat konobar", tables: [] });
    }
    groups.get(o.openedBy)!.tables.push({ tableId: o.table.id, tableLabel: o.table.label, orderId: o.id, itemCount: o.items.length, status: o.status });
  }
  const result = [...groups.values()];
  for (const g of result) g.tables.sort((a, b) => naturalCompare(a.tableLabel, b.tableLabel));
  result.sort((a, b) => a.employeeName.localeCompare(b.employeeName, "sr"));
  return result;
}

/**
 * "PREDAJA STOLOVA" — the caller's own open tables, for handing off before
 * ending their shift.
 */
export async function listMyOpenTables(ctx: AuthContext, locationId: string) {
  requireOrderOperator(ctx);
  requireLocationAccess(ctx, locationId);

  const orders = (await loadOpenOrdersForLocation(ctx, locationId)).filter((o) => o.openedBy === ctx.employeeId);
  const tables = orders
    .map((o) => ({ tableId: o.table.id, tableLabel: o.table.label, orderId: o.id, itemCount: o.items.length, status: o.status }))
    .sort((a, b) => naturalCompare(a.tableLabel, b.tableLabel));
  return tables;
}

/**
 * Active (non-terminated) waiters at a location, other than the caller —
 * the incoming-waiter picklist for "PREDAJA STOLOVA".
 */
export async function listActiveWaitersAtLocation(ctx: AuthContext, locationId: string) {
  requireOrderOperator(ctx);
  requireLocationAccess(ctx, locationId);

  const employees = await prisma.employee.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      status: "ACTIVE",
      id: { not: ctx.employeeId },
      locations: { some: { locationId } },
      roles: { some: { role: { name: { in: ["WAITER", "OWNER", "ADMIN", "MANAGER"] } } } },
    },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  return employees.map((e) => ({ employeeId: e.id, employeeName: `${e.firstName} ${e.lastName}` }));
}

interface TransferLineInput {
  orderId: string;
  expectedPreviousOwnerId: string;
  newOwnerId: string;
}

interface TransferLineResult {
  orderId: string;
  tableId: string;
  tableLabel: string;
  previousOwnerId: string;
  newOwnerId: string;
}

interface TransferLineFailure {
  orderId: string;
  tableLabel: string | null;
  error: string;
}

/**
 * Core engine — transfers ONE order's ownership atomically. Used directly
 * for a single-table transfer, and looped (independently per line, see
 * module doc) for bulk handover/handoff.
 *
 * `acceptedByEmployeeId` — who explicitly confirmed taking responsibility.
 * For self-service claim/handoff this is always the same as
 * `newOwnerId` (the incoming waiter's own authenticated action IS their
 * confirmation). For MANAGER_FORCED_TRANSFER it is left null (the new
 * owner did not proactively act) — never fabricated.
 */
async function transferOneOrder(
  ctx: AuthContext,
  input: { orderId: string; expectedPreviousOwnerId: string; newOwnerId: string; reason: TransferReason; acceptedByEmployeeId: string | null }
): Promise<TransferLineResult> {
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, ...scopeToRestaurant(ctx), status: OPEN_ORDER_STATUSES },
    select: { id: true, locationId: true, openedBy: true, table: { select: { id: true, label: true } } },
  });
  if (!order) throw new Error("Porudžbina nije pronađena ili više nije otvorena");
  requireLocationAccess(ctx, order.locationId);

  if (order.openedBy === input.newOwnerId) {
    throw new Error(`Sto "${order.table.label}" već pripada izabranom konobaru`);
  }

  // Self-service (SHIFT_HANDOVER/MANUAL_TABLE_TRANSFER) requires the caller
  // to be a genuine party to the transfer — either giving away a table they
  // currently hold, or claiming one for themselves. Prevents a bystander
  // WAITER from reassigning table X (belonging to A) to table-holder B
  // without either A or B acting. MANAGER_FORCED_TRANSFER is exempt (that's
  // exactly the case where neither party can act — see forceTransferTable).
  if (input.reason !== "MANAGER_FORCED_TRANSFER" && input.expectedPreviousOwnerId !== ctx.employeeId && input.newOwnerId !== ctx.employeeId) {
    throw new Error("Možeš preneti samo sto koji trenutno držiš, ili preuzeti sto za sebe");
  }

  const newOwner = await prisma.employee.findFirst({
    where: { id: input.newOwnerId, restaurantId: ctx.restaurantId, status: "ACTIVE", locations: { some: { locationId: order.locationId } } },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!newOwner) throw new Error("Novi konobar nije pronađen, nije aktivan, ili nema pristup ovoj lokaciji");

  const actorRole = ctx.roles[0] ?? "UNKNOWN";

  const result = await prisma.$transaction(async (tx) => {
    // Atomic conditional update — the actual concurrency guard. If someone
    // else already changed openedBy since the caller last read it, count
    // is 0 and we abort without touching anything.
    const guard = await tx.order.updateMany({
      where: { id: order.id, openedBy: input.expectedPreviousOwnerId, status: OPEN_ORDER_STATUSES },
      data: { openedBy: input.newOwnerId },
    });
    if (guard.count !== 1) {
      const fresh = await tx.order.findUnique({ where: { id: order.id }, select: { openedBy: true } });
      const actualOwnerName = fresh ? await employeeName(fresh.openedBy) : null;
      throw new StaleOwnershipError(order.table.label, actualOwnerName);
    }

    const previousOwnerName = await employeeName(input.expectedPreviousOwnerId);
    const newOwnerName = `${newOwner.firstName} ${newOwner.lastName}`;

    await tx.tableOwnershipTransfer.create({
      data: {
        restaurantId: ctx.restaurantId,
        locationId: order.locationId,
        orderId: order.id,
        tableId: order.table.id,
        tableLabel: order.table.label,
        previousOwnerId: input.expectedPreviousOwnerId,
        previousOwnerName,
        newOwnerId: input.newOwnerId,
        newOwnerName,
        initiatedBy: ctx.employeeId,
        initiatedByRole: actorRole,
        acceptedBy: input.acceptedByEmployeeId,
        reason: input.reason,
      },
    });

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "table_ownership_transferred",
        createdBy: ctx.employeeId,
        payload: { previousOwnerId: input.expectedPreviousOwnerId, newOwnerId: input.newOwnerId, reason: input.reason, tableLabel: order.table.label },
      },
    });

    await recordAuditEntry(
      ctx,
      {
        entityType: "Order",
        entityId: order.id,
        action: "order.owner_transferred",
        previousValue: { openedBy: input.expectedPreviousOwnerId },
        newValue: { openedBy: input.newOwnerId, reason: input.reason },
        locationId: order.locationId,
        category: "ADMIN_ACTION",
      },
      tx
    );

    return { orderId: order.id, tableId: order.table.id, tableLabel: order.table.label, previousOwnerId: input.expectedPreviousOwnerId, newOwnerId: input.newOwnerId };
  }, TX_OPTIONS);

  await ssePublisher.publish({
    type: "table.ownership_transferred",
    restaurantId: ctx.restaurantId,
    locationId: order.locationId,
    payload: { orderId: order.id, tableId: order.table.id, tableLabel: order.table.label, previousOwnerId: input.expectedPreviousOwnerId, newOwnerId: input.newOwnerId, reason: input.reason },
    occurredAt: new Date().toISOString(),
  });

  return result;
}

/**
 * Self-service claim AND/OR handoff, in one bulk-safe call — each line
 * names its OWN new owner, so a single outgoing waiter can distribute
 * different tables to different incoming waiters in one confirmation
 * (spec Section 4), while an incoming waiter claiming from several
 * previous owners at once (spec Section 3) is simply every line sharing
 * the same newOwnerId (= ctx.employeeId).
 *
 * `acceptedByEmployeeId` is derived per line, never fabricated: when a
 * line's newOwnerId is the CALLER themselves (self-service claim), the
 * claiming action itself IS their confirmation. When the caller is
 * handing a table to someone else (handoff), the new owner has not
 * touched their own device in this flow — acceptedBy stays null, exactly
 * like MANAGER_FORCED_TRANSFER's semantics.
 *
 * Bulk-safe: each line is independent (see module doc); returns both
 * succeeded and failed lines, never throws for a partial conflict.
 */
export async function transferTables(
  ctx: AuthContext,
  input: { transfers: TransferLineInput[]; reason: Extract<TransferReason, "SHIFT_HANDOVER" | "MANUAL_TABLE_TRANSFER"> }
): Promise<{ succeeded: TransferLineResult[]; failed: TransferLineFailure[] }> {
  requireOrderOperator(ctx);
  if (input.transfers.length === 0) throw new Error("Nema izabranih stolova za preuzimanje");
  if (input.transfers.length > 100) throw new Error("Previše stolova u jednom zahtevu");

  const succeeded: TransferLineResult[] = [];
  const failed: TransferLineFailure[] = [];

  for (const line of input.transfers) {
    try {
      const result = await transferOneOrder(ctx, {
        orderId: line.orderId,
        expectedPreviousOwnerId: line.expectedPreviousOwnerId,
        newOwnerId: line.newOwnerId,
        reason: input.reason,
        acceptedByEmployeeId: line.newOwnerId === ctx.employeeId ? ctx.employeeId : null,
      });
      succeeded.push(result);
    } catch (err) {
      failed.push({
        orderId: line.orderId,
        tableLabel: err instanceof StaleOwnershipError ? err.tableLabel : null,
        error: err instanceof Error ? err.message : "Greška",
      });
    }
  }

  return { succeeded, failed };
}

/**
 * MANAGER_FORCED_TRANSFER — for when the outgoing waiter is unavailable.
 * Gated on isOrderManager (OWNER/ADMIN/MANAGER), not on any PIN system
 * (none exists — see module doc). Never fabricates acceptedBy: the new
 * owner did not proactively act, so it stays null.
 */
export async function forceTransferTable(
  ctx: AuthContext,
  input: { orderId: string; newOwnerId: string }
): Promise<TransferLineResult> {
  if (!isOrderManager(ctx)) throw new Error("Samo menadžer ili vlasnik može prinudno preneti sto");

  const order = await prisma.order.findFirst({
    where: { id: input.orderId, ...scopeToRestaurant(ctx), status: OPEN_ORDER_STATUSES },
    select: { openedBy: true },
  });
  if (!order) throw new Error("Porudžbina nije pronađena ili više nije otvorena");

  return transferOneOrder(ctx, {
    orderId: input.orderId,
    expectedPreviousOwnerId: order.openedBy,
    newOwnerId: input.newOwnerId,
    reason: "MANAGER_FORCED_TRANSFER",
    acceptedByEmployeeId: null,
  });
}

export interface HandoverOverview {
  totalOpenTables: number;
  transferredCount: number;
  pendingTables: Array<{ tableId: string; tableLabel: string; orderId: string; currentOwnerId: string; currentOwnerName: string; itemCount: number }>;
  transferredTables: Array<{ tableId: string; tableLabel: string; orderId: string; previousOwnerName: string; newOwnerName: string; transferredAt: string }>;
}

/**
 * "PREUZIMANJE SMENE" overview — every currently-open table at the
 * location, split into "already transferred at least once" vs "still
 * pending", without any separate calculation: "transferred" is derived
 * from the existence of a TableOwnershipTransfer row for that still-open
 * order — the same authoritative openedBy field everything else reads.
 */
export async function getHandoverOverview(ctx: AuthContext, locationId: string): Promise<HandoverOverview> {
  requireOrderOperator(ctx);
  requireLocationAccess(ctx, locationId);

  const orders = await loadOpenOrdersForLocation(ctx, locationId);
  const orderIds = orders.map((o) => o.id);

  const transfers = orderIds.length
    ? await prisma.tableOwnershipTransfer.findMany({
        where: { orderId: { in: orderIds } },
        orderBy: { transferredAt: "desc" },
      })
    : [];
  const latestTransferByOrder = new Map<string, (typeof transfers)[number]>();
  for (const t of transfers) {
    if (!latestTransferByOrder.has(t.orderId)) latestTransferByOrder.set(t.orderId, t); // first = most recent, since ordered desc
  }

  const names = await namesFor(orders.map((o) => o.openedBy));

  const pendingTables: HandoverOverview["pendingTables"] = [];
  const transferredTables: HandoverOverview["transferredTables"] = [];

  for (const o of orders) {
    const transfer = latestTransferByOrder.get(o.id);
    if (transfer) {
      transferredTables.push({
        tableId: o.table.id,
        tableLabel: o.table.label,
        orderId: o.id,
        previousOwnerName: transfer.previousOwnerName,
        newOwnerName: transfer.newOwnerName,
        transferredAt: transfer.transferredAt.toISOString(),
      });
    } else {
      pendingTables.push({
        tableId: o.table.id,
        tableLabel: o.table.label,
        orderId: o.id,
        currentOwnerId: o.openedBy,
        currentOwnerName: names.get(o.openedBy) ?? "Nepoznat konobar",
        itemCount: o.items.length,
      });
    }
  }
  pendingTables.sort((a, b) => naturalCompare(a.tableLabel, b.tableLabel));
  transferredTables.sort((a, b) => naturalCompare(a.tableLabel, b.tableLabel));

  return {
    totalOpenTables: orders.length,
    transferredCount: transferredTables.length,
    pendingTables,
    transferredTables,
  };
}
