import { prisma, Prisma } from "@rcs/db";
import { requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { ssePublisher } from "../realtime/sse-publisher";
import { getActiveShift } from "../shifts/shift-service";
import { getOrder } from "../orders/order-service";
import { requireOrderOperator, requireDraftOwnership } from "../orders/order-access";
import { computeOrderTotals } from "../orders/order-totals";
import type { CompletePaymentInput } from "@rcs/shared";

const PAYABLE_STATUSES = new Set(["SUBMITTED", "ACCEPTED", "PREPARING", "READY", "SERVED"]);

async function loadOrderForBilling(ctx: AuthContext, orderId: string) {
  requireOrderOperator(ctx);
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...scopeToRestaurant(ctx) },
    include: { items: { orderBy: { createdAt: "asc" } }, table: true },
  });
  if (!order) throw new Error("Porudžbina nije pronađena");
  requireLocationAccess(ctx, order.locationId);
  if (order.status === "DRAFT") requireDraftOwnership(ctx, order.openedBy);
  return order;
}

/**
 * Pregled računa — subtotal/porez/ukupno se RAČUNAJU IZNOVA iz trenutnih
 * OrderItem snapshot redova na svaki poziv (nikad se ne čuvaju na Order-u)
 * da bi konobar uvek video tačno stanje, uključujući eventualne void-ovane
 * stavke (Faza 4). CANCELLED stavke se isključuju iz naplate.
 */
export async function getBillPreview(ctx: AuthContext, orderId: string) {
  const order = await loadOrderForBilling(ctx, orderId);
  const payableItems = order.items.filter((item) => item.status !== "CANCELLED");
  const totals = computeOrderTotals(payableItems);

  return {
    order,
    subtotal: totals.subtotal.toString(),
    tax: totals.tax.toString(),
    total: totals.total.toString(),
    taxBreakdown: totals.taxBreakdown,
    isPaid: order.status === "COMPLETED",
  };
}

/**
 * Konobar traži račun — prebacuje sto u AWAITING_BILL da drugi ekrani (npr.
 * nadzor) vide da se sto zatvara. NIJE preduslov za completePayment (koji
 * radi svoju sopstvenu, nezavisnu proveru stanja porudžbine) — samo UX/
 * vidljivost signalizacija, tako da poziv ovde nikad ne sme blokirati
 * naplatu ako je preskočen.
 */
export async function requestBill(ctx: AuthContext, orderId: string) {
  const order = await loadOrderForBilling(ctx, orderId);
  if (order.status === "COMPLETED") throw new Error("Porudžbina je već naplaćena");
  if (order.status === "CANCELLED") throw new Error("Porudžbina je otkazana");
  if (!PAYABLE_STATUSES.has(order.status)) {
    throw new Error("Porudžbina još nije poslata — nema šta da se naplati");
  }

  await prisma.$transaction(async (tx) => {
    await tx.restaurantTable.updateMany({
      where: { id: order.tableId, status: "OCCUPIED" },
      data: { status: "AWAITING_BILL" },
    });
    await tx.orderEvent.create({ data: { orderId, type: "bill_requested", createdBy: ctx.employeeId } });
  });

  return getBillPreview(ctx, orderId);
}

/**
 * Naplata — jedina kritična transakcija Faze 2. Iznos se UVEK računa na
 * serveru iz OrderItem redova u ovom trenutku; klijent šalje samo način
 * plaćanja i (za gotovinu, opciono) primljeni iznos za obračun kusura —
 * nikad sam iznos naplate.
 *
 * Zaštita od duple naplate: atomski `updateMany` sa WHERE status-guard-om
 * (isti obrazac kao production-service.advanceItemStatus) — Postgres
 * serijalizuje dva konkurentna poziva nad istim redom, samo jedan pogađa
 * WHERE klauzulu. `Payment.orderId @unique` je krajnja linija odbrane na
 * DB nivou za slučaj da guard ikad zaobiđe (npr. budući bug u pozivnom
 * kodu) — drugi INSERT puca na unique constraint umesto da tiho uspe.
 */
export async function completePayment(ctx: AuthContext, orderId: string, input: CompletePaymentInput) {
  const order = await loadOrderForBilling(ctx, orderId);
  if (order.status === "COMPLETED") throw new Error("Porudžbina je već naplaćena");
  if (order.status === "CANCELLED") throw new Error("Porudžbina je otkazana");
  if (!PAYABLE_STATUSES.has(order.status)) {
    throw new Error("Porudžbina još nije poslata — nema šta da se naplati");
  }

  const payableItems = order.items.filter((item) => item.status !== "CANCELLED");
  if (payableItems.length === 0) throw new Error("Porudžbina nema nijednu stavku za naplatu");

  const { subtotal, tax, total, taxBreakdown } = computeOrderTotals(payableItems);

  let tenderedAmount = total;
  let changeAmount = new Prisma.Decimal(0);
  if (input.method === "CASH" && input.tenderedAmount !== undefined) {
    tenderedAmount = new Prisma.Decimal(input.tenderedAmount);
    if (tenderedAmount.lessThan(total)) {
      throw new Error("Primljena gotovina je manja od ukupnog iznosa računa");
    }
    changeAmount = tenderedAmount.sub(total);
  }

  // Smena AKTIVNA SADA (ne order.shiftId) — vidi napomenu na Payment.shiftId
  // u schema.prisma.
  const shift = await getActiveShift(ctx, order.locationId);
  if (!shift) throw new Error("Nema aktivne smene na ovoj lokaciji — plaćanje nije moguće");

  const [restaurant, waiter] = await Promise.all([
    prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } }),
    prisma.employee.findUnique({ where: { id: order.openedBy }, select: { firstName: true, lastName: true } }),
  ]);

  const { payment, receipt } = await prisma.$transaction(async (tx) => {
    const guard = await tx.order.updateMany({
      where: { id: orderId, status: { notIn: ["DRAFT", "COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED" },
    });
    if (guard.count !== 1) {
      throw new Error("Porudžbina je već naplaćena ili nije u stanju za naplatu — osveži prikaz");
    }

    const payment = await tx.payment.create({
      data: {
        orderId,
        restaurantId: ctx.restaurantId,
        locationId: order.locationId,
        shiftId: shift.id,
        method: input.method,
        amount: total,
        tenderedAmount,
        changeAmount,
        completedBy: ctx.employeeId,
      },
    });

    const receipt = await tx.receipt.create({
      data: {
        orderId,
        paymentId: payment.id,
        restaurantId: ctx.restaurantId,
        locationId: order.locationId,
        restaurantName: restaurant.name,
        restaurantLegalName: restaurant.legalName,
        tableLabel: order.table.label,
        waiterName: waiter ? `${waiter.firstName} ${waiter.lastName}` : "?",
        paymentMethod: input.method,
        subtotal,
        taxTotal: tax,
        total,
        currency: restaurant.currency,
        items: payableItems.map((item) => ({
          name: item.name,
          price: item.price.toString(),
          taxRate: item.taxRate.toString(),
          quantity: item.quantity,
          lineTotal: new Prisma.Decimal(item.price).mul(item.quantity).toDecimalPlaces(2).toString(),
        })),
        taxBreakdown: taxBreakdown as never,
      },
    });

    // Sto se oslobađa ATOMSKI sa naplatom — nikad kao odvojen, ne-transakcioni
    // korak (zahtev specifikacije: "sto ne sme postati slobodan samo zato
    // što je neko zatvorio browser").
    await tx.restaurantTable.update({ where: { id: order.tableId }, data: { status: "FREE" } });

    await tx.orderEvent.create({
      data: {
        orderId,
        type: "payment_completed",
        createdBy: ctx.employeeId,
        payload: { method: input.method, amount: total.toString() },
      },
    });

    await recordAuditEntry(
      ctx,
      {
        entityType: "Order",
        entityId: orderId,
        action: "payment.completed",
        newValue: { method: input.method, amount: total.toString(), receiptId: receipt.id },
      },
      tx
    );

    return { payment, receipt };
  });

  await ssePublisher.publish({
    type: "payment.completed",
    restaurantId: ctx.restaurantId,
    locationId: order.locationId,
    payload: { orderId, tableId: order.tableId },
    occurredAt: new Date().toISOString(),
  });

  return { order: await getOrder(ctx, orderId), payment, receipt };
}

export async function getReceipt(ctx: AuthContext, orderId: string) {
  requireOrderOperator(ctx);
  const receipt = await prisma.receipt.findFirst({ where: { orderId, ...scopeToRestaurant(ctx) } });
  if (!receipt) throw new Error("Račun nije pronađen");
  requireLocationAccess(ctx, receipt.locationId);
  return receipt;
}
