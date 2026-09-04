import { prisma, type OrderItemStatus } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, ForbiddenError, type AuthContext } from "@rcs/auth";
import { ssePublisher } from "../realtime/sse-publisher";
import { aggregateStationStatus } from "./station-state";
import { requireOrderOperator } from "../orders/order-access";

const PRODUCTION_VIEW = "production.view";
const PRODUCTION_MANAGE = "production.manage";

export type Station = "KITCHEN" | "BAR";

/**
 * Kuhinja NE SME videti piće; šank NE SME videti hranu (eksplicitan
 * zahtev specifikacije). Permisija "production.view/manage" je zajednička
 * za oba ekrana — razdvajanje po stanici se sprovodi OVDE, na osnovu uloge
 * pozivaoca, ne na osnovu parametra koji bi klijent mogao da falsifikuje.
 */
export function assertStationAccess(ctx: AuthContext, station: Station): void {
  const isManagement = ctx.roles.some((r) => ["OWNER", "ADMIN", "MANAGER"].includes(r));
  if (isManagement) return; // nadzor sme da vidi obe stanice

  const hasStationRole = ctx.roles.includes(station === "KITCHEN" ? "KITCHEN" : "BAR");
  if (!hasStationRole) {
    throw new ForbiddenError(`Nemaš pristup ${station === "KITCHEN" ? "kuhinjskom" : "šankerskom"} ekranu`);
  }
}

const ACTIVE_ITEM_STATUSES: OrderItemStatus[] = ["SUBMITTED", "ACCEPTED", "PREPARING", "READY"];

/**
 * Vraća porudžbine koje imaju bar jednu aktivnu stavku za datu stanicu,
 * sa SAMO tim stavkama (ne celom porudžbinom) — kuhinjski ekran ne dobija
 * podatke o pićima čak ni posredno kroz `order.items`.
 */
export async function listStationOrders(ctx: AuthContext, locationId: string, station: Station) {
  requirePermission(ctx, PRODUCTION_VIEW);
  requireLocationAccess(ctx, locationId);
  assertStationAccess(ctx, station);

  const orders = await prisma.order.findMany({
    where: {
      ...scopeToRestaurant(ctx),
      locationId,
      status: { in: ["SUBMITTED", "ACCEPTED", "PREPARING", "READY", "SERVED"] },
      items: { some: { stationStates: { some: { station, status: { in: ACTIVE_ITEM_STATUSES } } } } },
    },
    include: {
      table: { select: { label: true } },
      items: {
        where: { stationStates: { some: { station, status: { in: ACTIVE_ITEM_STATUSES } } } },
        include: {
          stationStates: { where: { station }, select: { status: true } },
          // P3.2: dodaci moraju biti VIDLJIVI na KDS-u (specifikacija #16) —
          // isti include obrazac kao stationStates, jedan batch, ne po stavci.
          modifiers: { orderBy: { sortOrder: "asc" } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { submittedAt: "asc" },
  });

  // Konobar (openedBy) je employeeId, ne ime — dovodimo imena posebnim
  // upitom da ne opterećujemo Order include sa punom Employee relacijom.
  const employeeIds = Array.from(new Set(orders.map((o) => o.openedBy)));
  const employees = await prisma.employee.findMany({
    where: { id: { in: employeeIds }, ...scopeToRestaurant(ctx) },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  return orders.map((o) => ({
    orderId: o.id,
    tableLabel: o.table.label,
    waiterName: nameById.get(o.openedBy) ?? "?",
    submittedAt: o.submittedAt,
    items: o.items.map(({ stationStates, ...item }) => ({
      ...item,
      status: stationStates[0].status,
    })),
  }));
}

/**
 * Vraća porudžbine tekuće aktivne smene gde su SVE stavke za datu stanicu
 * u statusu SERVED — tj. kuhinja/šank su završili taj tiket.
 * Scoped na aktivnu smenu da lista ostane kompaktna.
 */
export async function listCompletedStationOrders(ctx: AuthContext, locationId: string, station: Station) {
  requirePermission(ctx, PRODUCTION_VIEW);
  requireLocationAccess(ctx, locationId);
  assertStationAccess(ctx, station);

  const activeShift = await prisma.shift.findFirst({
    where: { ...scopeToRestaurant(ctx), locationId, status: "OPEN" },
    select: { id: true },
  });
  if (!activeShift) return [];

  const orders = await prisma.order.findMany({
    where: {
      ...scopeToRestaurant(ctx),
      locationId,
      shiftId: activeShift.id,
      status: { notIn: ["DRAFT", "CANCELLED"] },
      items: { some: { stationStates: { some: { station } } } },
      NOT: {
        items: {
          some: {
            stationStates: {
              some: { station, status: { in: ACTIVE_ITEM_STATUSES } },
            },
          },
        },
      },
    },
    include: {
      table: { select: { label: true } },
      items: {
        where: { stationStates: { some: { station } } },
        include: {
          stationStates: { where: { station }, select: { status: true, updatedAt: true } },
          modifiers: { orderBy: { sortOrder: "asc" } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { submittedAt: "asc" },
  });

  const employeeIds = Array.from(new Set(orders.map((o) => o.openedBy)));
  const employees = await prisma.employee.findMany({
    where: { id: { in: employeeIds }, ...scopeToRestaurant(ctx) },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  return orders.map((o) => ({
    orderId: o.id,
    tableLabel: o.table.label,
    waiterName: nameById.get(o.openedBy) ?? "?",
    submittedAt: o.submittedAt,
    completedAt: o.items.flatMap((i) => i.stationStates).reduce(
      (max, s) => (s.updatedAt > max ? s.updatedAt : max),
      new Date(0)
    ),
    items: o.items.map(({ stationStates, ...item }) => ({
      ...item,
      status: stationStates[0]?.status ?? "SERVED",
    })),
  }));
}

// UPROŠĆEN TOK (Faza 10): Kuhinja/Šank sada idu direktno PRIHVATI -> SPREMNO
// (ACCEPTED -> READY, preskačući PREPARING/"Počni pripremu" koji se pokazao
// kao nepotreban dodatni korak). PREPARING OSTAJE u enumu i OSTAJE ovde kao
// validan sledeći korak — postojeće stavke koje su VEĆ u PREPARING stanju u
// trenutku deploy-a moraju i dalje moći da napreduju (PREPARING -> READY),
// bez migracije podataka (namerno aditivna, potpuno unazad-kompatibilna
// izmena, ne brisanje statusa). READY -> SERVED je NAMERNO uklonjeno odavde
// — preuzimanje (SERVED) više NIJE akcija Kuhinje/Šanka, vidi confirmPickup
// ispod (WAITER akcija, sopstvena autorizacija).
const NEXT_STATUS: Record<string, string> = {
  SUBMITTED: "ACCEPTED",
  ACCEPTED: "READY",
  PREPARING: "READY",
};

export async function advanceItemStatus(
  ctx: AuthContext,
  orderId: string,
  itemId: string,
  station: Station,
  expectedStatus: OrderItemStatus
) {
  requirePermission(ctx, PRODUCTION_MANAGE);
  assertStationAccess(ctx, station);

  const item = await prisma.orderItem.findFirst({
    where: {
      id: itemId,
      orderId,
      stationStates: { some: { station } },
      order: scopeToRestaurant(ctx),
    },
    include: { order: true, stationStates: true },
  });
  if (!item) throw new Error("Stavka nije pronađena za ovu stanicu");
  // restaurantId scoping (gore) nije dovoljan u restoranu sa više lokacija —
  // zaposleni na Lokaciji A ne sme pomerati stavke porudžbina Lokacije B.
  requireLocationAccess(ctx, item.order.locationId);

  const stationState = item.stationStates.find((state) => state.station === station);
  if (!stationState) throw new Error("Stavka nije pronađena za ovu stanicu");
  if (stationState.status !== expectedStatus) {
    throw new Error("Status stavke je već promenjen — osveži prikaz");
  }
  const nextStatus = NEXT_STATUS[expectedStatus];
  if (!nextStatus) throw new Error(`Stavka u statusu ${expectedStatus} se ne može dalje pomeriti`);

  const updated = await prisma.$transaction(async (tx) => {
    const advanced = await tx.orderItemStation.updateMany({
      where: { orderItemId: itemId, station, status: expectedStatus },
      data: { status: nextStatus as OrderItemStatus },
    });
    if (advanced.count !== 1) throw new Error("Status stavke je već promenjen — osveži prikaz");
    const state = await tx.orderItemStation.findUniqueOrThrow({
      where: { orderItemId_station: { orderItemId: itemId, station } },
    });
    const states = await tx.orderItemStation.findMany({
      where: { orderItemId: itemId },
      select: { status: true },
    });
    const aggregateStatus = aggregateStationStatus(states.map((entry) => entry.status));
    await tx.orderItem.update({ where: { id: itemId }, data: { status: aggregateStatus } });
    await tx.orderEvent.create({
      data: {
        orderId,
        type: "order_item.status_changed",
        createdBy: ctx.employeeId,
        payload: { itemId, from: expectedStatus, to: nextStatus, station, aggregateStatus },
      },
    });
    return state;
  });

  await ssePublisher.publish({
    type: "order_item.status_changed",
    restaurantId: ctx.restaurantId,
    locationId: item.order.locationId,
    payload: { orderId, itemId, status: nextStatus },
    occurredAt: new Date().toISOString(),
  });

  return updated;
}

/**
 * PREUZETO — konobar potvrđuje da je fizički preuzeo SPREMNU stavku sa
 * kuhinje/šanka. NAMERNO odvojeno od advanceItemStatus iznad: ovo je
 * konobarska (requireOrderOperator — WAITER ili menadžment), ne
 * kuhinjska/šank (production.manage + stanica) radnja — vidi napomenu uz
 * NEXT_STATUS. Item.status je već "READY" samo kada su SVE njegove stanice
 * (jedna za KITCHEN/BAR, obe za KITCHEN_AND_BAR) stigle do READY
 * (aggregateStationStatus = najmanje napredna) — zato je bezbedno da JEDAN
 * tap ovde označi SVAKU READY stanicu te stavke kao SERVED odjednom, bez
 * posebnog izbora stanice od strane konobara.
 */
export async function confirmPickup(ctx: AuthContext, orderId: string, itemId: string) {
  requireOrderOperator(ctx);

  const item = await prisma.orderItem.findFirst({
    where: { id: itemId, orderId, order: scopeToRestaurant(ctx) },
    include: { order: true },
  });
  if (!item) throw new Error("Stavka nije pronađena");
  requireLocationAccess(ctx, item.order.locationId);
  if (item.status !== "READY") {
    throw new Error("Stavka nije (više) spremna za preuzimanje — osveži prikaz");
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Isti "guard na trenutno stanje" obrazac kao svuda drugde (billing/void/
    // transfer) — zatvara race sa konkurentnim pokušajem preuzimanja iste
    // stavke (dva tapa, dva uređaja/konobara).
    const advanced = await tx.orderItemStation.updateMany({
      where: { orderItemId: itemId, status: "READY" },
      data: { status: "SERVED" },
    });
    if (advanced.count === 0) throw new Error("Stavka je već preuzeta — osveži prikaz");

    const updatedItem = await tx.orderItem.update({ where: { id: itemId }, data: { status: "SERVED" } });

    await tx.orderEvent.create({
      data: {
        orderId,
        type: "order_item.picked_up",
        createdBy: ctx.employeeId,
        payload: { itemId, name: item.name },
      },
    });

    return updatedItem;
  });

  await ssePublisher.publish({
    type: "order_item.status_changed",
    restaurantId: ctx.restaurantId,
    locationId: item.order.locationId,
    payload: { orderId, itemId, status: "SERVED" },
    occurredAt: new Date().toISOString(),
  });

  return updated;
}
