/**
 * Reservations V1 — internal table reservations. Reuses the existing
 * Restaurant/Location/Floor/RestaurantTable models (no parallel room/table
 * representation) and NEVER mutates RestaurantTable.status or creates an
 * Order — see packages/domain/reservations/reservation-service.ts's module
 * doc comment for the full architecture rationale.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@rcs/db";
import { ForbiddenError, type AuthContext } from "@rcs/auth";
import { reservations, tables, orders } from "@rcs/domain";
import { createReservationSchema, updateReservationSchema } from "@rcs/shared";
import { resetPrismaTestTables } from "../setup/reset-test-db";

interface Fixture {
  restaurantId: string;
  otherRestaurantId: string;
  locationId: string;
  otherLocationId: string;
}

function context(fixture: { restaurantId: string }, role: string, employeeId: string, locationIds: string[], permissions = new Set<string>()): AuthContext {
  return { userId: employeeId, employeeId, restaurantId: fixture.restaurantId, locationIds, roles: [role], permissions };
}

function waiterCtx(fixture: Fixture, employeeId = "waiter-1"): AuthContext {
  return context(fixture, "WAITER", employeeId, [fixture.locationId], new Set(["reservations.view", "reservations.manage", "settings.manage", "orders.print"]));
}
function otherRestaurantWaiterCtx(fixture: Fixture, employeeId = "waiter-b"): AuthContext {
  return { userId: employeeId, employeeId, restaurantId: fixture.otherRestaurantId, locationIds: [fixture.otherLocationId], roles: ["WAITER"], permissions: new Set(["reservations.view", "reservations.manage", "settings.manage"]) };
}

async function createFixture(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({ data: { name: "Reservations tenant", slug: `resv-${randomUUID()}` } });
  const restaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant A", currency: "RSD", timezone: "Europe/Belgrade" } });
  const otherRestaurant = await prisma.restaurant.create({ data: { tenantId: tenant.id, name: "Restaurant B", timezone: "Europe/Belgrade" } });
  const location = await prisma.location.create({ data: { restaurantId: restaurant.id, name: "Main" } });
  const otherLocation = await prisma.location.create({ data: { restaurantId: otherRestaurant.id, name: "Main" } });
  await prisma.shift.create({ data: { restaurantId: restaurant.id, locationId: location.id, openedBy: "seed" } });
  return { restaurantId: restaurant.id, otherRestaurantId: otherRestaurant.id, locationId: location.id, otherLocationId: otherLocation.id };
}

async function makeTable(fixture: Fixture, ctx: AuthContext, label = `T-${randomUUID().slice(0, 6)}`) {
  const floor = await tables.createFloor(ctx, { locationId: fixture.locationId, name: `Floor-${randomUUID().slice(0, 4)}` });
  return tables.createTable(ctx, { floorId: floor.id, label, capacity: 4 });
}

const FUTURE_DATE = "2099-06-15"; // always in the future, avoids any "past reservation" edge case affecting unrelated assertions

beforeEach(async () => {
  await resetPrismaTestTables(prisma, "tenants, permissions, login_throttles");
});

describe("createReservation", () => {
  it("creates a reservation WITH an assigned table", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");

    const reservation = await reservations.createReservation(ctx, {
      locationId: fixture.locationId, guestName: "Marko Petrović", phone: "0601234567",
      date: FUTURE_DATE, time: "19:30", partySize: 4, tableId: table.id,
    });

    expect(reservation.guestName).toBe("Marko Petrović");
    expect(reservation.status).toBe("CONFIRMED");
    expect(reservation.table?.id).toBe(table.id);
    expect(reservation.reservedAt.toISOString()).toContain("2099-06-15");
  });

  it("creates a reservation WITHOUT a table (Sto nije dodeljen)", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const reservation = await reservations.createReservation(ctx, {
      locationId: fixture.locationId, guestName: "Jelena Jovanović", phone: "0619876543",
      date: FUTURE_DATE, time: "20:00", partySize: 6,
    });
    expect(reservation.tableId).toBeNull();
    expect(reservation.table).toBeNull();
  });

  it("is audited", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Nikolić", phone: "060", date: FUTURE_DATE, time: "18:00", partySize: 2 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Reservation", entityId: reservation.id, action: "reservation.created" } });
    expect(audit.newValue).toMatchObject({ guestName: "Nikolić" });
  });

  it("rejects a table that doesn't belong to the given location", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    await expect(
      reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "18:00", partySize: 2, tableId: randomUUID() })
    ).rejects.toThrow(/nije pronađen/);
  });

  it("WAITER without reservations.manage cannot create", async () => {
    const fixture = await createFixture();
    const ctx = context(fixture, "WAITER", "w1", [fixture.locationId], new Set(["reservations.view"]));
    await expect(reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "18:00", partySize: 2 })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Validation (Zod schema)", () => {
  it("rejects a missing guest name / phone / date / time / partySize", () => {
    expect(() => createReservationSchema.parse({ locationId: randomUUID(), date: FUTURE_DATE, time: "18:00", partySize: 2 })).toThrow();
    expect(() => createReservationSchema.parse({ locationId: randomUUID(), guestName: "X", date: FUTURE_DATE, time: "18:00", partySize: 2 })).toThrow();
  });

  it("rejects an invalid date/time format", () => {
    expect(() => createReservationSchema.parse({ locationId: randomUUID(), guestName: "X", phone: "060", date: "15-06-2099", time: "18:00", partySize: 2 })).toThrow();
    expect(() => createReservationSchema.parse({ locationId: randomUUID(), guestName: "X", phone: "060", date: FUTURE_DATE, time: "6pm", partySize: 2 })).toThrow();
  });

  it("rejects a calendar-impossible date (e.g. Feb 30) instead of silently normalizing it forward", () => {
    expect(() => createReservationSchema.parse({ locationId: randomUUID(), guestName: "X", phone: "060", date: "2099-02-30", time: "18:00", partySize: 2 })).toThrow();
    expect(() => createReservationSchema.parse({ locationId: randomUUID(), guestName: "X", phone: "060", date: "2099-13-01", time: "18:00", partySize: 2 })).toThrow();
    // A real leap-year Feb 29 must still be accepted.
    expect(() => createReservationSchema.parse({ locationId: randomUUID(), guestName: "X", phone: "060", date: "2028-02-29", time: "18:00", partySize: 2 })).not.toThrow();
  });

  it("rejects an invalid guest count (zero or negative)", () => {
    expect(() => createReservationSchema.parse({ locationId: randomUUID(), guestName: "X", phone: "060", date: FUTURE_DATE, time: "18:00", partySize: 0 })).toThrow();
    expect(() => createReservationSchema.parse({ locationId: randomUUID(), guestName: "X", phone: "060", date: FUTURE_DATE, time: "18:00", partySize: -1 })).toThrow();
  });
});

describe("Conflict engine (server-side, spec section 5)", () => {
  it("rejects an overlapping reservation on the same table", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");
    await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "First", phone: "060", date: FUTURE_DATE, time: "19:30", partySize: 4, tableId: table.id });

    await expect(
      reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Second", phone: "061", date: FUTURE_DATE, time: "20:00", partySize: 2, tableId: table.id })
    ).rejects.toBeInstanceOf(reservations.ReservationConflictError);
  });

  it("allows a reservation outside the conflict window (90 min later)", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");
    await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "First", phone: "060", date: FUTURE_DATE, time: "19:30", partySize: 4, tableId: table.id });

    const second = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Second", phone: "061", date: FUTURE_DATE, time: "21:00", partySize: 2, tableId: table.id });
    expect(second.status).toBe("CONFIRMED");
  });

  it("allows an overlapping time on a DIFFERENT table", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const tableA = await makeTable(fixture, ctx, "Sto A");
    const tableB = await makeTable(fixture, ctx, "Sto B");
    await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "First", phone: "060", date: FUTURE_DATE, time: "19:30", partySize: 4, tableId: tableA.id });

    const second = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Second", phone: "061", date: FUTURE_DATE, time: "19:30", partySize: 2, tableId: tableB.id });
    expect(second.status).toBe("CONFIRMED");
  });

  it("a CANCELLED reservation does not block the table", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");
    const first = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "First", phone: "060", date: FUTURE_DATE, time: "19:30", partySize: 4, tableId: table.id });
    await reservations.cancelReservation(ctx, first.id);

    const second = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Second", phone: "061", date: FUTURE_DATE, time: "19:30", partySize: 2, tableId: table.id });
    expect(second.status).toBe("CONFIRMED");
  });

  it("a NO_SHOW reservation does not block the table", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");
    const first = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "First", phone: "060", date: FUTURE_DATE, time: "19:30", partySize: 4, tableId: table.id });
    await reservations.markNoShow(ctx, first.id);

    const second = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Second", phone: "061", date: FUTURE_DATE, time: "19:30", partySize: 2, tableId: table.id });
    expect(second.status).toBe("CONFIRMED");
  });

  it("concurrent create: two overlapping bookings racing for the same table — exactly one succeeds", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");

    const results = await Promise.allSettled([
      reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Racer A", phone: "060", date: FUTURE_DATE, time: "19:30", partySize: 2, tableId: table.id }),
      reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Racer B", phone: "061", date: FUTURE_DATE, time: "19:45", partySize: 2, tableId: table.id }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rows = await prisma.reservation.count({ where: { tableId: table.id, status: "CONFIRMED" } });
    expect(rows).toBe(1);
  });
});

describe("updateReservation", () => {
  it("edits guest info, time, date, and table", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const tableA = await makeTable(fixture, ctx, "Sto A");
    const tableB = await makeTable(fixture, ctx, "Sto B");
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Original", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2, tableId: tableA.id });

    const updated = await reservations.updateReservation(ctx, reservation.id, {
      guestName: "Updated Name", phone: "0699999999", date: "2099-06-16", time: "20:30", partySize: 5, tableId: tableB.id,
    });

    expect(updated.guestName).toBe("Updated Name");
    expect(updated.phone).toBe("0699999999");
    expect(updated.partySize).toBe(5);
    expect(updated.tableId).toBe(tableB.id);
    expect(updated.reservedAt.toISOString()).toContain("2099-06-16");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Reservation", entityId: reservation.id, action: "reservation.edited" } });
    expect(audit.previousValue).toMatchObject({ guestName: "Original" });
  });

  it("re-runs the conflict check when editing time/table into an occupied slot", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");
    await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Existing", phone: "060", date: FUTURE_DATE, time: "20:00", partySize: 2, tableId: table.id });
    const movable = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Movable", phone: "061", date: FUTURE_DATE, time: "17:00", partySize: 2, tableId: table.id });

    await expect(
      reservations.updateReservation(ctx, movable.id, { guestName: "Movable", phone: "061", date: FUTURE_DATE, time: "20:15", partySize: 2, tableId: table.id })
    ).rejects.toBeInstanceOf(reservations.ReservationConflictError);
  });

  it("editing a reservation against ITSELF (same time/table) never falsely conflicts", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Solo", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2, tableId: table.id });

    const updated = await reservations.updateReservation(ctx, reservation.id, { guestName: "Solo Renamed", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 3, tableId: table.id });
    expect(updated.partySize).toBe(3);
  });

  it("cannot edit a CANCELLED or COMPLETED reservation", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2 });
    await reservations.cancelReservation(ctx, reservation.id);

    await expect(
      reservations.updateReservation(ctx, reservation.id, { guestName: "Y", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2 })
    ).rejects.toThrow(/ne može menjati/);
  });
});

describe("Status lifecycle", () => {
  it("CONFIRMED -> SEATED using the already-assigned table", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx);
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2, tableId: table.id });

    const seated = await reservations.markSeated(ctx, reservation.id, null);
    expect(seated.status).toBe("SEATED");
    expect(seated.seatedAt).not.toBeNull();
    expect(seated.tableId).toBe(table.id);
  });

  it("CONFIRMED -> SEATED without a table REQUIRES one to be provided", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2 });

    await expect(reservations.markSeated(ctx, reservation.id, null)).rejects.toThrow(/Izaberi sto/);

    const table = await makeTable(fixture, ctx);
    const seated = await reservations.markSeated(ctx, reservation.id, table.id);
    expect(seated.tableId).toBe(table.id);
    expect(seated.status).toBe("SEATED");
  });

  it("CONFIRMED -> NO_SHOW", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2 });
    const result = await reservations.markNoShow(ctx, reservation.id);
    expect(result.status).toBe("NO_SHOW");
  });

  it("CONFIRMED -> CANCELLED, and cancelling twice is idempotent (no throw)", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2 });
    const cancelled = await reservations.cancelReservation(ctx, reservation.id, "Guest called to cancel");
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.cancelledBy).toBe(ctx.employeeId);

    const again = await reservations.cancelReservation(ctx, reservation.id);
    expect(again.status).toBe("CANCELLED");
  });

  it("SEATED -> COMPLETED", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx);
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2, tableId: table.id });
    await reservations.markSeated(ctx, reservation.id, null);
    const completed = await reservations.completeReservation(ctx, reservation.id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).not.toBeNull();
  });

  it("cannot cancel an already COMPLETED reservation", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx);
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2, tableId: table.id });
    await reservations.markSeated(ctx, reservation.id, null);
    await reservations.completeReservation(ctx, reservation.id);
    await expect(reservations.cancelReservation(ctx, reservation.id)).rejects.toThrow(/ne može otkazati/);
  });
});

describe("Multi-restaurant security (spec section 19, non-negotiable)", () => {
  it("Restaurant A cannot list Restaurant B's reservations", async () => {
    const fixture = await createFixture();
    const ctxA = waiterCtx(fixture);
    const ctxB = otherRestaurantWaiterCtx(fixture);
    await reservations.createReservation(ctxB, { locationId: fixture.otherLocationId, guestName: "B-guest", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2 });

    const listA = await reservations.listReservationsForDate(ctxA, fixture.locationId, FUTURE_DATE);
    expect(listA).toHaveLength(0);
  });

  it("Restaurant A cannot read a Restaurant B reservation by id", async () => {
    const fixture = await createFixture();
    const ctxA = waiterCtx(fixture);
    const ctxB = otherRestaurantWaiterCtx(fixture);
    const bReservation = await reservations.createReservation(ctxB, { locationId: fixture.otherLocationId, guestName: "B-guest", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2 });

    await expect(reservations.getReservation(ctxA, bReservation.id)).rejects.toThrow(/nije pronađena/);
  });

  it("Restaurant A cannot update a Restaurant B reservation", async () => {
    const fixture = await createFixture();
    const ctxA = waiterCtx(fixture);
    const ctxB = otherRestaurantWaiterCtx(fixture);
    const bReservation = await reservations.createReservation(ctxB, { locationId: fixture.otherLocationId, guestName: "B-guest", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2 });

    await expect(
      reservations.updateReservation(ctxA, bReservation.id, { guestName: "Hacked", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2 })
    ).rejects.toThrow(/nije pronađena/);
  });

  it("Restaurant A cannot cancel a Restaurant B reservation", async () => {
    const fixture = await createFixture();
    const ctxA = waiterCtx(fixture);
    const ctxB = otherRestaurantWaiterCtx(fixture);
    const bReservation = await reservations.createReservation(ctxB, { locationId: fixture.otherLocationId, guestName: "B-guest", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2 });

    await expect(reservations.cancelReservation(ctxA, bReservation.id)).rejects.toThrow(/nije pronađena/);
    const stillConfirmed = await prisma.reservation.findUniqueOrThrow({ where: { id: bReservation.id } });
    expect(stillConfirmed.status).toBe("CONFIRMED");
  });

  it("search is also restaurant-scoped", async () => {
    const fixture = await createFixture();
    const ctxA = waiterCtx(fixture);
    const ctxB = otherRestaurantWaiterCtx(fixture);
    await reservations.createReservation(ctxB, { locationId: fixture.otherLocationId, guestName: "SharedName Guest", phone: "0611111111", date: FUTURE_DATE, time: "19:00", partySize: 2 });

    const results = await reservations.searchReservations(ctxA, fixture.locationId, "SharedName");
    expect(results).toHaveLength(0);
  });
});

describe("Regression — Reservations never touch existing Table/Order architecture (spec section 13/22)", () => {
  it("creating a reservation for a table does NOT change RestaurantTable.status", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");
    await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2, tableId: table.id });

    const after = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: table.id } });
    expect(after.status).toBe("FREE");
  });

  it("creating a reservation does NOT create an Order", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");
    await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2, tableId: table.id });

    const orderCount = await prisma.order.count({ where: { tableId: table.id } });
    expect(orderCount).toBe(0);
  });

  it("markSeated is a pure status change — still does not create an Order or touch RestaurantTable.status", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");
    const reservation = await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "X", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2, tableId: table.id });
    await reservations.markSeated(ctx, reservation.id, null);

    const tableAfter = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: table.id } });
    expect(tableAfter.status).toBe("FREE");
    const orderCount = await prisma.order.count({ where: { tableId: table.id } });
    expect(orderCount).toBe(0);
  });

  it("a table with an upcoming reservation still opens a normal Order exactly as before (openOrder unaffected)", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 7");
    // Reservation 30 minutes from now — inside the "upcoming" window.
    const soon = new Date(Date.now() + 30 * 60_000);
    const dateStr = soon.toISOString().slice(0, 10);
    const timeStr = `${String(soon.getUTCHours()).padStart(2, "0")}:${String(soon.getUTCMinutes()).padStart(2, "0")}`;
    await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Upcoming Guest", phone: "060", date: dateStr, time: timeStr, partySize: 2, tableId: table.id });

    const order = await orders.openOrder(ctx, { tableId: table.id });
    expect(order).toBeTruthy();
    const tableAfter = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: table.id } });
    expect(tableAfter.status).toBe("OCCUPIED"); // normal openOrder behavior, unaffected by the reservation
  });

  it("getUpcomingReservationsForTables surfaces the reservation on the table card without altering other listTables() fields", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 9");
    const soon = new Date(Date.now() + 20 * 60_000);
    const dateStr = soon.toISOString().slice(0, 10);
    const timeStr = `${String(soon.getUTCHours()).padStart(2, "0")}:${String(soon.getUTCMinutes()).padStart(2, "0")}`;
    await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Card Guest", phone: "060", date: dateStr, time: timeStr, partySize: 3, tableId: table.id });

    const floors = await tables.listTables(ctx, fixture.locationId);
    const found = floors.flatMap((f) => f.tables).find((t) => t.id === table.id)!;
    expect(found.upcomingReservation?.guestName).toBe("Card Guest");
    expect(found.upcomingReservation?.partySize).toBe(3);
    expect(found.status).toBe("FREE"); // untouched
    expect(found.activeOrderOwnerId).toBeNull(); // untouched
  });

  it("a reservation far in the future does NOT show up as 'upcoming' on the table card", async () => {
    const fixture = await createFixture();
    const ctx = waiterCtx(fixture);
    const table = await makeTable(fixture, ctx, "Sto 10");
    await reservations.createReservation(ctx, { locationId: fixture.locationId, guestName: "Far Future Guest", phone: "060", date: FUTURE_DATE, time: "19:00", partySize: 2, tableId: table.id });

    const floors = await tables.listTables(ctx, fixture.locationId);
    const found = floors.flatMap((f) => f.tables).find((t) => t.id === table.id)!;
    expect(found.upcomingReservation).toBeNull();
  });
});
