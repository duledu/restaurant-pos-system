import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import type { OpenShiftInput, CloseShiftInput } from "@rcs/shared";

const SHIFTS_MANAGE = "shifts.manage";

/**
 * Konobar/kuhinja/šank ne smeju raditi bez aktivne smene na svojoj lokaciji
 * (vidi v2 plan, pravilo #6). Ova funkcija je ono što svaki POS/KDS/bar
 * endpoint poziva PRE bilo koje operacije da dobije shiftId.
 */
export async function getActiveShift(ctx: AuthContext, locationId: string) {
  requireLocationAccess(ctx, locationId);
  return prisma.shift.findFirst({
    where: { ...scopeToRestaurant(ctx), locationId, status: "OPEN" },
  });
}

export async function openShift(ctx: AuthContext, input: OpenShiftInput) {
  requirePermission(ctx, SHIFTS_MANAGE);
  requireLocationAccess(ctx, input.locationId);

  const existing = await getActiveShift(ctx, input.locationId);
  if (existing) {
    throw new Error("Već postoji otvorena smena na ovoj lokaciji");
  }

  // Partial unique index (shifts_one_open_per_location) na bazi je
  // KRAJNJA linija odbrane protiv race condition-a (dva konobara otvaraju
  // smenu istovremeno) — ova provera iznad je samo brža, korisniku
  // prijateljska poruka pre nego što upit uopšte ode ka bazi.
  const shift = await prisma.shift.create({
    data: {
      restaurantId: ctx.restaurantId,
      locationId: input.locationId,
      openedBy: ctx.employeeId,
      openingCash: input.openingCash,
    },
  });

  await recordAuditEntry(ctx, {
    entityType: "Shift",
    entityId: shift.id,
    action: "shift.opened",
    newValue: { locationId: input.locationId, openingCash: input.openingCash },
    locationId: input.locationId,
  });

  return shift;
}

async function loadShiftForClosing(ctx: AuthContext, shiftId: string) {
  requirePermission(ctx, SHIFTS_MANAGE);
  const shift = await prisma.shift.findFirst({ where: { id: shiftId, ...scopeToRestaurant(ctx) } });
  if (!shift) throw new Error("Smena nije pronađena");
  requireLocationAccess(ctx, shift.locationId);
  return shift;
}

/**
 * Payment.shiftId je smena AKTIVNA U TRENUTKU PLAĆANJA (vidi napomenu u
 * schema.prisma) — zato je zbir Payment redova po shiftId tačan izvor za
 * gotovinu/karticu ove smene, bez obzira na to kad je porudžbina OTVORENA.
 */
async function summarizeShiftPayments(shiftId: string) {
  const payments = await prisma.payment.findMany({
    where: { shiftId },
    select: { method: true, amount: true },
  });
  let cashTotal = new Prisma.Decimal(0);
  let cardTotal = new Prisma.Decimal(0);
  for (const payment of payments) {
    if (payment.method === "CASH") cashTotal = cashTotal.add(payment.amount);
    else cardTotal = cardTotal.add(payment.amount);
  }
  return { cashTotal, cardTotal, orderCount: payments.length };
}

/**
 * Pregled pre zatvaranja — konobar/menadžer vidi očekivanu gotovinu PRE
 * nego što unese prebrojan iznos. Ništa se ovde ne upisuje/zamrzava (vidi
 * closeShift za to) — poziva se slobodno, koliko god puta, bez posledice.
 */
export async function getShiftSummary(ctx: AuthContext, shiftId: string) {
  const shift = await loadShiftForClosing(ctx, shiftId);

  const [{ cashTotal, cardTotal, orderCount }, openOrders] = await Promise.all([
    summarizeShiftPayments(shiftId),
    prisma.order.findMany({
      where: { shiftId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      include: { table: { select: { label: true } } },
    }),
  ]);
  const expectedCash = new Prisma.Decimal(shift.openingCash).add(cashTotal);

  return {
    shift,
    openingCash: shift.openingCash.toString(),
    cashTotal: cashTotal.toString(),
    cardTotal: cardTotal.toString(),
    expectedCash: expectedCash.toString(),
    totalRevenue: cashTotal.add(cardTotal).toString(),
    orderCount,
    openOrders: openOrders.map((o) => ({ id: o.id, tableLabel: o.table.label, status: o.status })),
    canClose: shift.status === "OPEN" && openOrders.length === 0,
  };
}

/**
 * Zatvaranje smene — jedina kritična transakcija Faze 3. Odbija zatvaranje
 * ako postoje otvoreni (nenaplaćeni, neotkazani) računi na ovoj smeni —
 * prihod smene mora biti kompletan pre nego što se brojevi zamrznu.
 * countedCash/expectedCash/cashDifference se upisuju JEDNOM i nikad posle
 * ne menjaju (nema update endpoint-a) — razlika ostaje vidljiva zauvek,
 * nikad se "tiho ne ispravlja" (zahtev specifikacije).
 */
export async function closeShift(ctx: AuthContext, shiftId: string, input: CloseShiftInput) {
  const shift = await loadShiftForClosing(ctx, shiftId);
  if (shift.status === "CLOSED") throw new Error("Smena je već zatvorena");

  const openOrders = await prisma.order.findMany({
    where: { shiftId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    include: { table: { select: { label: true } } },
  });
  if (openOrders.length > 0) {
    const labels = openOrders.map((o) => o.table.label).join(", ");
    throw new Error(`Ne može se zatvoriti smena — postoje otvoreni računi: ${labels}`);
  }

  const { cashTotal, cardTotal, orderCount } = await summarizeShiftPayments(shiftId);
  const expectedCash = new Prisma.Decimal(shift.openingCash).add(cashTotal);
  const countedCash = new Prisma.Decimal(input.countedCash);
  const cashDifference = countedCash.sub(expectedCash);
  const totalRevenue = cashTotal.add(cardTotal);

  const closed = await prisma.$transaction(async (tx) => {
    // Atomski status-guard (isti obrazac kao billing.completePayment) —
    // sprečava da dva konkurentna poziva zatvore istu smenu dva puta.
    const guard = await tx.shift.updateMany({
      where: { id: shiftId, status: "OPEN" },
      data: {
        status: "CLOSED",
        closedBy: ctx.employeeId,
        closedAt: new Date(),
        countedCash,
        expectedCash,
        cashDifference,
        cardTotal,
        totalRevenue,
        orderCount,
      },
    });
    if (guard.count !== 1) throw new Error("Smena je već zatvorena — osveži prikaz");

    await recordAuditEntry(
      ctx,
      {
        entityType: "Shift",
        entityId: shiftId,
        action: "shift.closed",
        newValue: {
          countedCash: countedCash.toString(),
          expectedCash: expectedCash.toString(),
          cashDifference: cashDifference.toString(),
          cardTotal: cardTotal.toString(),
          totalRevenue: totalRevenue.toString(),
          orderCount,
        },
        locationId: shift.locationId,
      },
      tx
    );

    return tx.shift.findUniqueOrThrow({ where: { id: shiftId } });
  });

  return closed;
}
