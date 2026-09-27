/**
 * REZERVACIJE V1 — interna rezervacija stola.
 *
 * Reuses the EXISTING Restaurant/Location/Floor/RestaurantTable models —
 * no parallel room/table representation. `Reservation.tableId` is a weak,
 * optional reference (SetNull) so a reservation may exist before a table is
 * assigned. This module NEVER mutates `RestaurantTable.status`, never
 * creates an `Order`, and never touches Payment/KDS/Inventory — a
 * reservation only DESCRIBES expected guests; staff open the actual
 * table/order through the existing, unmodified POS engine exactly as
 * before (see markSeated below, which is a pure reservation-status change).
 *
 * TIMEZONE: `reservedAt` is always computed from the RESTAURANT's timezone
 * (Restaurant.timezone), never the browser/phone's, via the same DST-safe
 * primitive already used by Promotions (packages/shared/promotion-schedule.ts
 * zonedDateTimeToInstant) — one single technique for "local wall-clock time
 * in this restaurant" across both features.
 *
 * DURATION: V1 deliberately has no restaurant-configurable reservation
 * duration (would expand this phase for no proven need yet, per spec) — a
 * fixed server-side default (RESERVATION_DEFAULT_DURATION_MINUTES) is used
 * for conflict-window math only, stored per-row for future flexibility but
 * never exposed in the V1 UI. Documented decision, not an oversight.
 *
 * CONCURRENCY: two staff racing to book the SAME table for an overlapping
 * time must never both succeed. A conflict check that only reads EXISTING
 * rows cannot close this race when the table has zero prior reservations
 * (nothing to lock). Instead each create/reschedule takes a Postgres
 * transaction-scoped advisory lock keyed by the target tableId
 * (pg_advisory_xact_lock(hashtext(tableId))) BEFORE reading candidates —
 * this serializes any two concurrent attempts against the same table
 * regardless of whether a row already exists, and is released automatically
 * at transaction end. Same "lock inside the transaction" idiom already used
 * by billing-service.ts's `SELECT ... FOR UPDATE`, adapted to the "maybe
 * zero existing rows" case that a row-lock can't cover.
 */
import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { zonedDateTimeToInstant, zonedWallClock, addDaysToDateString } from "@rcs/shared";
import type { CreateReservationInput, UpdateReservationInput } from "@rcs/shared";

const RESERVATIONS_VIEW = "reservations.view";
const RESERVATIONS_MANAGE = "reservations.manage";

const RESERVATION_DEFAULT_DURATION_MINUTES = 90;
/** How far ahead a reservation counts as "upcoming" for a table card (spec section 14) — a defensible, simple V1 choice: long enough to matter operationally, short enough not to clutter the floor view with the whole evening's bookings. */
const UPCOMING_WINDOW_MINUTES = 60;

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

const ACTIVE_STATUSES: Array<"CONFIRMED" | "SEATED"> = ["CONFIRMED", "SEATED"];

export class ReservationConflictError extends Error {
  constructor(
    public readonly tableLabel: string,
    public readonly conflictingGuestName: string,
    public readonly conflictingTimeLabel: string
  ) {
    super(`Sto "${tableLabel}" već ima rezervaciju u ${conflictingTimeLabel} (${conflictingGuestName}).`);
  }
}

function timeToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function timeLabel(at: Date, timeZone: string): string {
  const wc = zonedWallClock(at, timeZone);
  return `${String(Math.floor(wc.minutesSinceMidnight / 60)).padStart(2, "0")}:${String(wc.minutesSinceMidnight % 60).padStart(2, "0")}`;
}

async function getRestaurantTimezone(restaurantId: string): Promise<string> {
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { timezone: true } });
  return restaurant.timezone;
}

async function loadActiveTable(locationId: string, tableId: string): Promise<{ id: string; label: string }> {
  const table = await prisma.restaurantTable.findFirst({
    where: { id: tableId, isActive: true, floor: { locationId } },
    select: { id: true, label: true },
  });
  if (!table) throw new Error("Sto nije pronađen na ovoj lokaciji");
  return table;
}

/**
 * Locks the target table (see module doc — advisory lock, not a row lock)
 * then checks every other still-active (CONFIRMED/SEATED) reservation for
 * that table for a time-window overlap. Must be called from INSIDE the
 * same transaction that will insert/update the reservation.
 */
async function lockTableAndAssertNoConflict(
  tx: Prisma.TransactionClient,
  params: { tableId: string; tableLabel: string; reservedAt: Date; durationMinutes: number; timezone: string; excludeReservationId?: string }
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.tableId}))`;

  const newEnd = new Date(params.reservedAt.getTime() + params.durationMinutes * 60_000);
  const candidates = await tx.reservation.findMany({
    where: {
      tableId: params.tableId,
      status: { in: ACTIVE_STATUSES },
      ...(params.excludeReservationId ? { id: { not: params.excludeReservationId } } : {}),
    },
    select: { reservedAt: true, durationMinutes: true, guestName: true },
  });

  for (const candidate of candidates) {
    const existingEnd = new Date(candidate.reservedAt.getTime() + candidate.durationMinutes * 60_000);
    const overlaps = candidate.reservedAt < newEnd && params.reservedAt < existingEnd;
    if (overlaps) {
      throw new ReservationConflictError(params.tableLabel, candidate.guestName, timeLabel(candidate.reservedAt, params.timezone));
    }
  }
}

const RESERVATION_INCLUDE = {
  table: { select: { id: true, label: true, floor: { select: { id: true, name: true } } } },
} satisfies Prisma.ReservationInclude;

/** "DANAS" screen (spec section 6) — every reservation (any status) whose reservedAt falls on `date` (restaurant-timezone calendar day), chronological. Includes cancelled/no-show so staff retain full context — the client visually de-emphasizes non-active ones. */
export async function listReservationsForDate(ctx: AuthContext, locationId: string, date: string) {
  requirePermission(ctx, RESERVATIONS_VIEW);
  requireLocationAccess(ctx, locationId);

  const tz = await getRestaurantTimezone(ctx.restaurantId);
  const dayStart = zonedDateTimeToInstant(date, 0, tz);
  const dayEnd = zonedDateTimeToInstant(addDaysToDateString(date, 1), 0, tz);

  return prisma.reservation.findMany({
    where: { ...scopeToRestaurant(ctx), locationId, reservedAt: { gte: dayStart, lt: dayEnd } },
    orderBy: { reservedAt: "asc" },
    include: RESERVATION_INCLUDE,
  });
}

/** Spec section 17 — search by guest name or phone, across all dates. */
export async function searchReservations(ctx: AuthContext, locationId: string, query: string) {
  requirePermission(ctx, RESERVATIONS_VIEW);
  requireLocationAccess(ctx, locationId);
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  return prisma.reservation.findMany({
    where: {
      ...scopeToRestaurant(ctx),
      locationId,
      OR: [{ guestName: { contains: trimmed, mode: "insensitive" } }, { phone: { contains: trimmed } }],
    },
    orderBy: { reservedAt: "desc" },
    take: 50,
    include: RESERVATION_INCLUDE,
  });
}

export async function getReservation(ctx: AuthContext, id: string) {
  requirePermission(ctx, RESERVATIONS_VIEW);
  const reservation = await prisma.reservation.findFirst({ where: { id, ...scopeToRestaurant(ctx) }, include: RESERVATION_INCLUDE });
  if (!reservation) throw new Error("Rezervacija nije pronađena");
  requireLocationAccess(ctx, reservation.locationId);
  return reservation;
}

export async function createReservation(ctx: AuthContext, input: CreateReservationInput) {
  requirePermission(ctx, RESERVATIONS_MANAGE);
  requireLocationAccess(ctx, input.locationId);

  const tz = await getRestaurantTimezone(ctx.restaurantId);
  const reservedAt = zonedDateTimeToInstant(input.date, timeToMinutes(input.time), tz);

  const table = input.tableId ? await loadActiveTable(input.locationId, input.tableId) : null;

  const reservation = await prisma.$transaction(async (tx) => {
    if (table) {
      await lockTableAndAssertNoConflict(tx, {
        tableId: table.id,
        tableLabel: table.label,
        reservedAt,
        durationMinutes: RESERVATION_DEFAULT_DURATION_MINUTES,
        timezone: tz,
      });
    }

    const created = await tx.reservation.create({
      data: {
        restaurantId: ctx.restaurantId,
        locationId: input.locationId,
        tableId: table?.id ?? null,
        guestName: input.guestName.trim(),
        phone: input.phone.trim(),
        partySize: input.partySize,
        reservedAt,
        durationMinutes: RESERVATION_DEFAULT_DURATION_MINUTES,
        note: input.note,
        createdBy: ctx.employeeId,
        updatedBy: ctx.employeeId,
      },
      include: RESERVATION_INCLUDE,
    });

    await recordAuditEntry(
      ctx,
      {
        entityType: "Reservation",
        entityId: created.id,
        action: "reservation.created",
        newValue: { guestName: created.guestName, phone: created.phone, partySize: created.partySize, reservedAt: created.reservedAt.toISOString(), tableId: created.tableId },
        locationId: input.locationId,
        category: "reservation",
      },
      tx
    );

    return created;
  }, TX_OPTIONS);

  return reservation;
}

export async function updateReservation(ctx: AuthContext, id: string, input: UpdateReservationInput) {
  requirePermission(ctx, RESERVATIONS_MANAGE);
  const existing = await prisma.reservation.findFirst({ where: { id, ...scopeToRestaurant(ctx) } });
  if (!existing) throw new Error("Rezervacija nije pronađena");
  requireLocationAccess(ctx, existing.locationId);
  if (existing.status === "CANCELLED" || existing.status === "COMPLETED") {
    throw new Error("Otkazana ili završena rezervacija se ne može menjati");
  }

  const tz = await getRestaurantTimezone(ctx.restaurantId);
  const reservedAt = zonedDateTimeToInstant(input.date, timeToMinutes(input.time), tz);
  const table = input.tableId ? await loadActiveTable(existing.locationId, input.tableId) : null;

  const updated = await prisma.$transaction(async (tx) => {
    if (table) {
      await lockTableAndAssertNoConflict(tx, {
        tableId: table.id,
        tableLabel: table.label,
        reservedAt,
        durationMinutes: existing.durationMinutes,
        timezone: tz,
        excludeReservationId: id,
      });
    }

    const result = await tx.reservation.update({
      where: { id },
      data: {
        guestName: input.guestName.trim(),
        phone: input.phone.trim(),
        partySize: input.partySize,
        tableId: table?.id ?? null,
        reservedAt,
        note: input.note,
        updatedBy: ctx.employeeId,
      },
      include: RESERVATION_INCLUDE,
    });

    await recordAuditEntry(
      ctx,
      {
        entityType: "Reservation",
        entityId: id,
        action: "reservation.edited",
        previousValue: { guestName: existing.guestName, phone: existing.phone, partySize: existing.partySize, reservedAt: existing.reservedAt.toISOString(), tableId: existing.tableId },
        newValue: { guestName: result.guestName, phone: result.phone, partySize: result.partySize, reservedAt: result.reservedAt.toISOString(), tableId: result.tableId },
        locationId: existing.locationId,
        category: "reservation",
      },
      tx
    );

    return result;
  }, TX_OPTIONS);

  return updated;
}

export async function cancelReservation(ctx: AuthContext, id: string, reason?: string) {
  requirePermission(ctx, RESERVATIONS_MANAGE);
  const existing = await prisma.reservation.findFirst({ where: { id, ...scopeToRestaurant(ctx) } });
  if (!existing) throw new Error("Rezervacija nije pronađena");
  requireLocationAccess(ctx, existing.locationId);
  if (existing.status === "CANCELLED") return existing; // idempotent — retry-safe
  if (existing.status === "COMPLETED") throw new Error("Završena rezervacija se ne može otkazati");

  return prisma.$transaction(async (tx) => {
    const result = await tx.reservation.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: ctx.employeeId, updatedBy: ctx.employeeId },
      include: RESERVATION_INCLUDE,
    });
    await recordAuditEntry(
      ctx,
      { entityType: "Reservation", entityId: id, action: "reservation.cancelled", previousValue: { status: existing.status }, newValue: { status: "CANCELLED" }, reason, locationId: existing.locationId, category: "reservation" },
      tx
    );
    return result;
  }, TX_OPTIONS);
}

/**
 * "GOSTI SU STIGLI" (spec section 12) — a PURE reservation-status change.
 * Never creates an Order, never touches RestaurantTable.status — staff
 * still open the table/order through the normal, unmodified POS flow. If
 * the reservation already has a table, that table is used; otherwise
 * `tableId` is required (enforced below).
 */
export async function markSeated(ctx: AuthContext, id: string, tableId: string | null) {
  requirePermission(ctx, RESERVATIONS_MANAGE);
  const existing = await prisma.reservation.findFirst({ where: { id, ...scopeToRestaurant(ctx) } });
  if (!existing) throw new Error("Rezervacija nije pronađena");
  requireLocationAccess(ctx, existing.locationId);
  if (existing.status !== "CONFIRMED") throw new Error("Samo potvrđena rezervacija može biti označena kao 'gosti stigli'");

  const finalTableId = existing.tableId ?? tableId;
  if (!finalTableId) throw new Error("Izaberi sto pre nego što smestiš goste");
  if (!existing.tableId) await loadActiveTable(existing.locationId, finalTableId);

  return prisma.$transaction(async (tx) => {
    const result = await tx.reservation.update({
      where: { id },
      data: { status: "SEATED", seatedAt: new Date(), tableId: finalTableId, updatedBy: ctx.employeeId },
      include: RESERVATION_INCLUDE,
    });
    await recordAuditEntry(ctx, { entityType: "Reservation", entityId: id, action: "reservation.seated", newValue: { tableId: finalTableId }, locationId: existing.locationId, category: "reservation" }, tx);
    return result;
  }, TX_OPTIONS);
}

export async function markNoShow(ctx: AuthContext, id: string) {
  requirePermission(ctx, RESERVATIONS_MANAGE);
  const existing = await prisma.reservation.findFirst({ where: { id, ...scopeToRestaurant(ctx) } });
  if (!existing) throw new Error("Rezervacija nije pronađena");
  requireLocationAccess(ctx, existing.locationId);
  if (existing.status !== "CONFIRMED") throw new Error("Samo potvrđena rezervacija može biti označena da gosti nisu došli");

  return prisma.$transaction(async (tx) => {
    const result = await tx.reservation.update({ where: { id }, data: { status: "NO_SHOW", updatedBy: ctx.employeeId }, include: RESERVATION_INCLUDE });
    await recordAuditEntry(ctx, { entityType: "Reservation", entityId: id, action: "reservation.no_show", previousValue: { status: existing.status }, newValue: { status: "NO_SHOW" }, locationId: existing.locationId, category: "reservation" }, tx);
    return result;
  }, TX_OPTIONS);
}

export async function completeReservation(ctx: AuthContext, id: string) {
  requirePermission(ctx, RESERVATIONS_MANAGE);
  const existing = await prisma.reservation.findFirst({ where: { id, ...scopeToRestaurant(ctx) } });
  if (!existing) throw new Error("Rezervacija nije pronađena");
  requireLocationAccess(ctx, existing.locationId);
  if (existing.status !== "SEATED") throw new Error("Samo smeštena rezervacija može biti označena kao završena");

  return prisma.$transaction(async (tx) => {
    const result = await tx.reservation.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date(), updatedBy: ctx.employeeId }, include: RESERVATION_INCLUDE });
    await recordAuditEntry(ctx, { entityType: "Reservation", entityId: id, action: "reservation.completed", previousValue: { status: existing.status }, newValue: { status: "COMPLETED" }, locationId: existing.locationId, category: "reservation" }, tx);
    return result;
  }, TX_OPTIONS);
}

export interface UpcomingReservationBrief {
  id: string;
  guestName: string;
  partySize: number;
  reservedAt: Date;
}

/**
 * Internal — powers the "Rezervacija za 35 min" indicator on the waiter
 * floor view (spec section 14/15). Called from table-service.ts's
 * listTables(), which has ALREADY validated the caller's access to
 * `locationId` — no separate permission check here, same convention as
 * promotion-service.ts's listActivePromotionRulesForSnapshot. ONE batched
 * query for every table on the floor (never N+1), riding listTables()'s
 * existing 5-second poll rather than adding a new fetch loop.
 */
export async function getUpcomingReservationsForTables(restaurantId: string, locationId: string, tableIds: string[]): Promise<Map<string, UpcomingReservationBrief>> {
  const map = new Map<string, UpcomingReservationBrief>();
  if (tableIds.length === 0) return map;

  const now = new Date();
  const windowEnd = new Date(now.getTime() + UPCOMING_WINDOW_MINUTES * 60_000);
  const rows = await prisma.reservation.findMany({
    where: { restaurantId, locationId, tableId: { in: tableIds }, status: "CONFIRMED", reservedAt: { gte: now, lt: windowEnd } },
    orderBy: { reservedAt: "asc" },
    select: { id: true, tableId: true, guestName: true, partySize: true, reservedAt: true },
  });
  for (const row of rows) {
    if (!row.tableId || map.has(row.tableId)) continue; // first = earliest, since ordered asc
    map.set(row.tableId, { id: row.id, guestName: row.guestName, partySize: row.partySize, reservedAt: row.reservedAt });
  }
  return map;
}
