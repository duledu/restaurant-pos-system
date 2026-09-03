import { prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { sortByLabelNatural } from "@rcs/shared";
import { recordAuditEntry } from "../audit/audit-service";

// ─── Waiter (POS) queries ─────────────────────────────────────────────────────

/**
 * Grid prikaz stolova za konobarski POS — namerno bez punog floor-plan
 * modela (pozicije x/y su extension point za kasniju fazu, vidi
 * docs/01-RCS-Plan-v2-MVP.md). MVP UI grupiše po Floor.name i prikazuje
 * dugmad u redosledu label-a.
 */
export async function listTables(ctx: AuthContext, locationId: string) {
  requireLocationAccess(ctx, locationId);

  const floors = await prisma.floor.findMany({
    where: { ...scopeToRestaurant(ctx), locationId },
    include: {
      tables: {
        where: { isActive: true },
        // Hitno ispravljeno: konobar mora da zna PRE navigacije da li sto
        // već drži DRUGI konobar (order.openedBy), da ne bi ušao u tuđu
        // porudžbinu i naleteo na "Ovu porudžbinu je otvorio drugi konobar"
        // tek posle klika. Vraća SAMO employeeId (nikad ime/lične podatke)
        // — dovoljno da frontend uporedi sa sopstvenim ctx.employeeId, bez
        // dodatnog upita/endpoint-a (vidi napomenu u pos-client.tsx).
        // Uniqueness pravilo (openOrder) garantuje najviše JEDNU aktivnu
        // porudžbinu po stolu, pa je take:1 uvek dovoljno.
        include: {
          orders: {
            where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
            select: {
              openedBy: true,
              // FAZA 10 — SPREMNO obaveštenje konobaru: OrderItem.status
              // "READY" je već tačan agregat (najmanje napredna stanica —
              // vidi aggregateStationStatus) da je stavka SPREMNA ZA
              // PREUZIMANJE. Vraćamo SAMO id/name (mala, minimalna dodatna
              // težina po stolu) — dovoljno da klijent izračuna broj I
              // otkrije KOJE konkretne stavke su nove otkad je poslednji put
              // pitao (za zvuk "samo za genuinski nov READY događaj", ne
              // samo broj koji bi mogao ostati isti dok se stavke menjaju).
              items: { where: { status: "READY" }, select: { id: true, name: true } },
            },
            take: 1,
          },
        },
        orderBy: { label: "asc" },
      },
    },
    orderBy: { sortOrder: "asc" },
  });

  return floors.map((floor) => ({
    ...floor,
    // Prisma orderBy: { label: "asc" } iznad je LEKSIKOGRAFSKO (string)
    // poređenje — "Sto 10" bi upalo ODMAH posle "Sto 1" (pre "Sto 2"), jer
    // Postgres upoređuje karakter-po-karakter. sortByLabelNatural ovde
    // ispravlja redosled na numerički-svestan ("Sto 1, Sto 2, ..., Sto 9,
    // Sto 10"), bezbedno i za nazive koji nisu čist broj (vidi natural-sort.ts).
    tables: sortByLabelNatural(floor.tables).map(({ orders, ...table }) => ({
      ...table,
      activeOrderOwnerId: orders[0]?.openedBy ?? null,
      readyItems: orders[0]?.items ?? [],
    })),
  }));
}

export async function getTable(ctx: AuthContext, tableId: string) {
  const table = await prisma.restaurantTable.findFirst({
    where: {
      id: tableId,
      floor: scopeToRestaurant(ctx),
    },
    include: { floor: true },
  });
  if (!table) throw new Error("Sto nije pronađen");
  requireLocationAccess(ctx, table.floor.locationId);
  if (!table.isActive) throw new Error("Sto nije aktivan i ne može se koristiti za porudžbine");
  return table;
}

// ─── Admin queries ────────────────────────────────────────────────────────────

/**
 * Admin listing — shows all tables (active and inactive) for management.
 * Requires settings.manage (OWNER / ADMIN / MANAGER).
 */
export async function adminListFloors(ctx: AuthContext, locationId: string) {
  requirePermission(ctx, "settings.manage");
  requireLocationAccess(ctx, locationId);

  const floors = await prisma.floor.findMany({
    where: { ...scopeToRestaurant(ctx), locationId },
    include: {
      tables: { orderBy: { label: "asc" } },
    },
    orderBy: { sortOrder: "asc" },
  });

  // Isti razlog kao listTables iznad — Prisma orderBy je leksikografsko,
  // ovde se ispravlja na numerički-svestan redosled.
  return floors.map((floor) => ({ ...floor, tables: sortByLabelNatural(floor.tables) }));
}

// ─── Floor mutations ──────────────────────────────────────────────────────────

export async function createFloor(
  ctx: AuthContext,
  input: { locationId: string; name: string }
) {
  requirePermission(ctx, "settings.manage");
  requireLocationAccess(ctx, input.locationId);

  const name = input.name.trim();
  if (!name) throw new Error("Naziv sale je obavezan");
  if (name.length > 80) throw new Error("Naziv sale je predugačak (max 80 znakova)");

  const location = await prisma.location.findFirst({
    where: { id: input.locationId, restaurantId: ctx.restaurantId },
  });
  if (!location) throw new Error("Lokacija nije pronađena");

  // sortOrder = max + 1 so new floors go to the end
  const maxOrder = await prisma.floor.aggregate({
    where: { restaurantId: ctx.restaurantId, locationId: input.locationId },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1;

  const floor = await prisma.floor.create({
    data: {
      restaurantId: ctx.restaurantId,
      locationId: input.locationId,
      name,
      sortOrder,
    },
  });

  await recordAuditEntry(ctx, {
    entityType: "Floor",
    entityId: floor.id,
    action: "floor.created",
    newValue: { name, locationId: input.locationId },
    locationId: input.locationId,
  });

  return floor;
}

export async function updateFloor(
  ctx: AuthContext,
  floorId: string,
  input: { name: string }
) {
  requirePermission(ctx, "settings.manage");

  const floor = await prisma.floor.findFirst({
    where: { id: floorId, restaurantId: ctx.restaurantId },
  });
  if (!floor) throw new Error("Sala nije pronađena");
  requireLocationAccess(ctx, floor.locationId);

  const name = input.name.trim();
  if (!name) throw new Error("Naziv sale je obavezan");
  if (name.length > 80) throw new Error("Naziv sale je predugačak (max 80 znakova)");

  const updated = await prisma.floor.update({
    where: { id: floorId },
    data: { name },
  });

  await recordAuditEntry(ctx, {
    entityType: "Floor",
    entityId: floorId,
    action: "floor.renamed",
    previousValue: { name: floor.name },
    newValue: { name },
    locationId: floor.locationId,
  });

  return updated;
}

// ─── Table mutations ──────────────────────────────────────────────────────────

export async function createTable(
  ctx: AuthContext,
  input: { floorId: string; label: string; capacity?: number }
) {
  requirePermission(ctx, "settings.manage");

  const floor = await prisma.floor.findFirst({
    where: { id: input.floorId, restaurantId: ctx.restaurantId },
  });
  if (!floor) throw new Error("Sala nije pronađena");
  requireLocationAccess(ctx, floor.locationId);

  const label = input.label.trim();
  if (!label) throw new Error("Naziv stola je obavezan");
  if (label.length > 40) throw new Error("Naziv stola je predugačak (max 40 znakova)");

  const capacity = input.capacity ?? 2;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 999)
    throw new Error("Broj mesta mora biti ceo broj između 1 i 999");

  // Uniqueness: no two active tables in the same floor with the same label
  const duplicate = await prisma.restaurantTable.findFirst({
    where: { floorId: input.floorId, label, isActive: true },
  });
  if (duplicate) throw new Error(`Sto "${label}" već postoji u ovoj sali`);

  const table = await prisma.restaurantTable.create({
    data: { floorId: input.floorId, label, capacity },
  });

  await recordAuditEntry(ctx, {
    entityType: "RestaurantTable",
    entityId: table.id,
    action: "table.created",
    newValue: { label, capacity, floorId: input.floorId, floorName: floor.name },
    locationId: floor.locationId,
  });

  return table;
}

export async function updateTable(
  ctx: AuthContext,
  tableId: string,
  input: { label?: string; capacity?: number; floorId?: string }
) {
  requirePermission(ctx, "settings.manage");

  const table = await prisma.restaurantTable.findFirst({
    where: { id: tableId, floor: scopeToRestaurant(ctx) },
    include: { floor: true },
  });
  if (!table) throw new Error("Sto nije pronađen");
  requireLocationAccess(ctx, table.floor.locationId);

  const data: { label?: string; capacity?: number; floorId?: string } = {};
  const auditChanges: Record<string, unknown> = {};

  if (input.label !== undefined) {
    const label = input.label.trim();
    if (!label) throw new Error("Naziv stola je obavezan");
    if (label.length > 40) throw new Error("Naziv stola je predugačak (max 40 znakova)");
    const targetFloorId = input.floorId ?? table.floorId;
    if (label !== table.label || targetFloorId !== table.floorId) {
      const duplicate = await prisma.restaurantTable.findFirst({
        where: { floorId: targetFloorId, label, isActive: true, NOT: { id: tableId } },
      });
      if (duplicate) throw new Error(`Sto "${label}" već postoji u toj sali`);
    }
    data.label = label;
    if (label !== table.label) auditChanges.label = { from: table.label, to: label };
  }

  if (input.capacity !== undefined) {
    const capacity = input.capacity;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 999)
      throw new Error("Broj mesta mora biti ceo broj između 1 i 999");
    data.capacity = capacity;
    if (capacity !== table.capacity) auditChanges.capacity = { from: table.capacity, to: capacity };
  }

  if (input.floorId !== undefined && input.floorId !== table.floorId) {
    const newFloor = await prisma.floor.findFirst({
      where: { id: input.floorId, restaurantId: ctx.restaurantId },
    });
    if (!newFloor) throw new Error("Nova sala nije pronađena");
    requireLocationAccess(ctx, newFloor.locationId);
    data.floorId = input.floorId;
    auditChanges.floor = { from: table.floor.name, to: newFloor.name };
  }

  if (Object.keys(data).length === 0) return table;

  const updated = await prisma.restaurantTable.update({ where: { id: tableId }, data });

  await recordAuditEntry(ctx, {
    entityType: "RestaurantTable",
    entityId: tableId,
    action: "table.updated",
    previousValue: { label: table.label, capacity: table.capacity, floorId: table.floorId },
    newValue: auditChanges,
    locationId: table.floor.locationId,
  });

  return updated;
}

export async function deactivateTable(ctx: AuthContext, tableId: string) {
  requirePermission(ctx, "settings.manage");

  const table = await prisma.restaurantTable.findFirst({
    where: { id: tableId, floor: scopeToRestaurant(ctx) },
    include: { floor: true },
  });
  if (!table) throw new Error("Sto nije pronađen");
  requireLocationAccess(ctx, table.floor.locationId);

  if (!table.isActive) throw new Error("Sto je već deaktiviran");

  // Block deactivation if the table has any open/active order
  const activeOrder = await prisma.order.findFirst({
    where: { tableId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  if (activeOrder) {
    throw new Error("Sto trenutno ima aktivnu porudžbinu i ne može biti deaktiviran.");
  }

  const updated = await prisma.restaurantTable.update({
    where: { id: tableId },
    data: { isActive: false },
  });

  await recordAuditEntry(ctx, {
    entityType: "RestaurantTable",
    entityId: tableId,
    action: "table.deactivated",
    newValue: { label: table.label, floorName: table.floor.name },
    locationId: table.floor.locationId,
  });

  return updated;
}

export async function activateTable(ctx: AuthContext, tableId: string) {
  requirePermission(ctx, "settings.manage");

  const table = await prisma.restaurantTable.findFirst({
    where: { id: tableId, floor: scopeToRestaurant(ctx) },
    include: { floor: true },
  });
  if (!table) throw new Error("Sto nije pronađen");
  requireLocationAccess(ctx, table.floor.locationId);

  if (table.isActive) throw new Error("Sto je već aktivan");

  const updated = await prisma.restaurantTable.update({
    where: { id: tableId },
    data: { isActive: true },
  });

  await recordAuditEntry(ctx, {
    entityType: "RestaurantTable",
    entityId: tableId,
    action: "table.activated",
    newValue: { label: table.label, floorName: table.floor.name },
    locationId: table.floor.locationId,
  });

  return updated;
}
