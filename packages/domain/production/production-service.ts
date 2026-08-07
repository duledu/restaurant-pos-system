import { prisma, type OrderItemStatus } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, ForbiddenError, type AuthContext } from "@rcs/auth";
import { ssePublisher } from "../realtime/sse-publisher";

const PRODUCTION_VIEW = "production.view";
const PRODUCTION_MANAGE = "production.manage";

export type Station = "KITCHEN" | "BAR";

/**
 * Kuhinja NE SME videti piće; šank NE SME videti hranu (eksplicitan
 * zahtev specifikacije). Permisija "production.view/manage" je zajednička
 * za oba ekrana — razdvajanje po stanici se sprovodi OVDE, na osnovu uloge
 * pozivaoca, ne na osnovu parametra koji bi klijent mogao da falsifikuje.
 */
function assertStationAccess(ctx: AuthContext, station: Station): void {
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
      items: { some: { preparationStation: station, status: { in: ACTIVE_ITEM_STATUSES } } },
    },
    include: {
      table: { select: { label: true } },
      items: {
        where: { preparationStation: station },
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
    items: o.items,
  }));
}

const NEXT_STATUS: Record<string, string> = {
  SUBMITTED: "ACCEPTED",
  ACCEPTED: "PREPARING",
  PREPARING: "READY",
  READY: "SERVED",
};

export async function advanceItemStatus(ctx: AuthContext, orderId: string, itemId: string, station: Station) {
  requirePermission(ctx, PRODUCTION_MANAGE);
  assertStationAccess(ctx, station);

  const item = await prisma.orderItem.findFirst({
    where: { id: itemId, orderId, preparationStation: station, order: scopeToRestaurant(ctx) },
    include: { order: true },
  });
  if (!item) throw new Error("Stavka nije pronađena za ovu stanicu");
  // restaurantId scoping (gore) nije dovoljan u restoranu sa više lokacija —
  // zaposleni na Lokaciji A ne sme pomerati stavke porudžbina Lokacije B.
  requireLocationAccess(ctx, item.order.locationId);

  const nextStatus = NEXT_STATUS[item.status];
  if (!nextStatus) throw new Error(`Stavka u statusu ${item.status} se ne može dalje pomeriti`);

  const updated = await prisma.orderItem.update({ where: { id: itemId }, data: { status: nextStatus as never } });

  await prisma.orderEvent.create({
    data: {
      orderId,
      type: "order_item.status_changed",
      createdBy: ctx.employeeId,
      payload: { itemId, from: item.status, to: nextStatus, station },
    },
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
