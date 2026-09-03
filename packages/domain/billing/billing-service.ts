import { prisma, Prisma } from "@rcs/db";
import { requireLocationAccess, scopeToRestaurant, ForbiddenError, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { ssePublisher } from "../realtime/sse-publisher";
import { getActiveShift } from "../shifts/shift-service";
import { getOrder } from "../orders/order-service";
import { requireOrderOperator, requireDraftOwnership, isOrderManager } from "../orders/order-access";
import { computeOrderTotals } from "../orders/order-totals";
import { dispatchReceiptPrintJob } from "../printing/print-service";
import { validateAndDecrementInventoryInTx } from "../inventory/inventory-service";
import { validateAndDecrementIngredientsInTx } from "../inventory/ingredient-service";
import type { CompletePaymentInput } from "@rcs/shared";

const PAYABLE_STATUSES = new Set(["SUBMITTED", "ACCEPTED", "PREPARING", "READY", "SERVED"]);

async function loadOrderForBilling(ctx: AuthContext, orderId: string) {
  requireOrderOperator(ctx);
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...scopeToRestaurant(ctx) },
    include: {
      items: { include: { modifiers: { orderBy: { sortOrder: "asc" } } }, orderBy: { createdAt: "asc" } },
      table: true,
    },
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
 * stavke (Faza 4). CANCELLED stavke se isključuju iz naplate. VIŠE-KRUŽNO
 * NARUČIVANJE (Faza 9): DRAFT stavke (neposlat naredni krug, još nikad
 * poslat kuhinji/šanku) se TAKOĐE isključuju — gost se ne naplaćuje za
 * nešto što još nije ni poslato, i eventualno se predomisli/ukloni pre
 * slanja.
 */
export async function getBillPreview(ctx: AuthContext, orderId: string) {
  const order = await loadOrderForBilling(ctx, orderId);
  const payableItems = order.items.filter((item) => item.status !== "CANCELLED" && item.status !== "DRAFT");
  const totals = computeOrderTotals(payableItems, order.discountAmount ?? 0);

  return {
    order,
    subtotal: totals.subtotal.toString(),
    tax: totals.tax.toString(),
    discount: totals.discount.toString(),
    total: totals.total.toString(),
    taxBreakdown: totals.taxBreakdown,
    isPaid: order.status === "COMPLETED",
  };
}

/**
 * Popust na nivou cele porudžbine (Faza 6) — menadžment-only, ista logika
 * osetljivosti kao void (konobar ne sme sam sebi "popustiti" račun). Sme se
 * primeniti samo dok porudžbina NIJE naplaćena — posle completePayment-a
 * popust je već zamrznut u Receipt-u i menja se samo kroz Faza 4-stil
 * korekciju (van obima ove faze).
 */
export async function applyOrderDiscount(
  ctx: AuthContext,
  orderId: string,
  input: { amount: number; reason: string }
) {
  requireOrderOperator(ctx);
  if (!isOrderManager(ctx)) {
    throw new ForbiddenError("Samo menadžer ili vlasnik može odobriti popust");
  }
  const order = await prisma.order.findFirst({ where: { id: orderId, ...scopeToRestaurant(ctx) } });
  if (!order) throw new Error("Porudžbina nije pronađena");
  requireLocationAccess(ctx, order.locationId);
  if (order.status === "COMPLETED" || order.status === "CANCELLED") {
    throw new Error("Porudžbina je već zatvorena — popust se ne može primeniti");
  }
  if (input.amount < 0) throw new Error("Iznos popusta ne može biti negativan");

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { discountAmount: input.amount, discountReason: input.reason.trim() || null },
  });

  await recordAuditEntry(ctx, {
    entityType: "Order",
    entityId: orderId,
    action: "order.discount_applied",
    newValue: { amount: input.amount, reason: input.reason },
    locationId: order.locationId,
  });

  return updated;
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
 * Zaštita od duple naplate: isti Order-row lock kao split-bill put. Cela
 * naplata je dozvoljena samo ako nijedna živa količina još nije plaćena;
 * zatim se paidQuantity, PaymentItem ledger, Payment/Receipt, COMPLETED i
 * oslobađanje stola upisuju u istoj transakciji.
 */
export async function completePayment(ctx: AuthContext, orderId: string, input: CompletePaymentInput) {
  const order = await loadOrderForBilling(ctx, orderId);
  if (order.status === "COMPLETED") throw new Error("Porudžbina je već naplaćena");
  if (order.status === "CANCELLED") throw new Error("Porudžbina je otkazana");
  if (!PAYABLE_STATUSES.has(order.status)) {
    throw new Error("Porudžbina još nije poslata — nema šta da se naplati");
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
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
    const freshOrder = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { include: { modifiers: { orderBy: { sortOrder: "asc" } } } }, table: true },
    });
    if (freshOrder.status === "COMPLETED") throw new Error("Porudžbina je već naplaćena");
    if (freshOrder.status === "CANCELLED") throw new Error("Porudžbina je otkazana");
    if (!PAYABLE_STATUSES.has(freshOrder.status)) throw new Error("Porudžbina još nije poslata — nema šta da se naplati");

    // VIŠE-KRUŽNO NARUČIVANJE: DRAFT stavke (neposlat naredni krug) se
    // NIKAD ne naplaćuju — ali njihovo POSTOJANJE mora blokirati punu
    // (jednokratnu) naplatu cele porudžbine (specifikacija Faze 9 #9:
    // "Order closes only when ... no active unsent items remain"). Bez ove
    // provere bi puna naplata mogla zatvoriti porudžbinu (i osloboditi sto)
    // dok neposlata stavka ostane "osirotela" — porudžbina je zatvorena,
    // stavka se više nikad ne može ni poslati ni ukloniti.
    const draftItems = freshOrder.items.filter((item) => item.status === "DRAFT");
    if (draftItems.length > 0) {
      throw new Error(
        `Porudžbina ima neposlate stavke (${draftItems.map((i) => i.name).join(", ")}) — pošalji ih kuhinji/šanku ili ih ukloni pre naplate.`
      );
    }

    // (draftItems je već proveren/blokiran iznad — ovaj filter je defense-
    // in-depth, ne oslanja se samo na proveru iznad.)
    const payableItems = freshOrder.items.filter((item) => item.status !== "CANCELLED" && item.status !== "DRAFT");
    if (payableItems.length === 0) throw new Error("Porudžbina nema nijednu stavku za naplatu");
    if (payableItems.some((item) => item.paidQuantity !== 0)) {
      throw new Error("Porudžbina je već delimično naplaćena — preostale stavke naplati kroz Podeli račun");
    }

    const { subtotal, tax, discount, total, taxBreakdown } = computeOrderTotals(payableItems, freshOrder.discountAmount ?? 0);
    let tenderedAmount = total;
    let changeAmount = new Prisma.Decimal(0);
    if (input.method === "CASH" && input.tenderedAmount !== undefined) {
      tenderedAmount = new Prisma.Decimal(input.tenderedAmount);
      if (tenderedAmount.lessThan(total)) throw new Error("Primljena gotovina je manja od ukupnog iznosa računa");
      changeAmount = tenderedAmount.sub(total);
    }

    for (const item of payableItems) {
      const itemGuard = await tx.orderItem.updateMany({
        where: { id: item.id, quantity: item.quantity, paidQuantity: 0, status: { not: "CANCELLED" } },
        data: { paidQuantity: item.quantity },
      });
      if (itemGuard.count !== 1) throw new Error("Stavka je izmenjena u međuvremenu — osveži prikaz i pokušaj ponovo");
    }

    const payment = await tx.payment.create({
      data: {
        orderId,
        restaurantId: ctx.restaurantId,
        locationId: freshOrder.locationId,
        shiftId: shift.id,
        method: input.method,
        amount: total,
        tenderedAmount,
        changeAmount,
        completedBy: ctx.employeeId,
        // FAZA 8: puna (jednokratna) naplata nosi CEO popust porudžbine kao
        // svoj udeo — isto polje koje split-bill-service.ts popunjava
        // prorata-udelom po delimičnoj naplati, tako da analytics-service.ts/
        // reporting-service.ts mogu čitati SAMO Payment.discountAmount
        // (nikad Order.discountAmount) bez obzira da li je porudžbina
        // naplaćena odjednom ili podeljeno.
        discountAmount: discount.isZero() ? null : discount,
      },
    });

    await tx.paymentItem.createMany({
      data: payableItems.map((item) => ({
        paymentId: payment.id,
        orderItemId: item.id,
        quantity: item.quantity,
        unitPrice: item.price,
        taxRate: item.taxRate,
        lineTotal: new Prisma.Decimal(item.price).mul(item.quantity).toDecimalPlaces(2),
      })),
    });

    await validateAndDecrementInventoryInTx(tx, {
      paymentId: payment.id,
      orderId,
      restaurantId: ctx.restaurantId,
      locationId: freshOrder.locationId,
      items: payableItems.map((it) => ({ menuItemId: it.menuItemId, quantity: it.quantity })),
    });

    // P1.2: automatsko skidanje sirovina po normativu (Normativi) — potpuno
    // NEZAVISNO od gotov-proizvod inventara iznad (različiti artikli mogu
    // koristiti jedno, drugo, oba ili nijedno — vidi napomenu na vrhu
    // ingredient-service.ts). Unutar ISTE transakcije: greška ovde
    // rollback-uje CELU naplatu (Payment/Receipt/sto/OrderEvent), tačno kao
    // nedovoljna zaliha gotovog artikla iznad.
    await validateAndDecrementIngredientsInTx(tx, {
      paymentId: payment.id,
      orderId,
      restaurantId: ctx.restaurantId,
      locationId: freshOrder.locationId,
      items: payableItems.map((it) => ({ menuItemId: it.menuItemId, quantity: it.quantity })),
    });

    const receipt = await tx.receipt.create({
      data: {
        orderId,
        paymentId: payment.id,
        restaurantId: ctx.restaurantId,
        locationId: freshOrder.locationId,
        restaurantName: restaurant.name,
        restaurantLegalName: restaurant.legalName,
        tableLabel: freshOrder.table.label,
        waiterName: waiter ? `${waiter.firstName} ${waiter.lastName}` : "?",
        paymentMethod: input.method,
        subtotal,
        taxTotal: tax,
        total,
        currency: restaurant.currency,
        discountAmount: discount.isZero() ? null : discount,
        // P3.2: `price`/`lineTotal` ostaju NEPROMENJENI po značenju (efektivna
        // jedinična cena × količina — ista računica kao pre modifikatora).
        // `basePrice`/`modifiers` su ADITIVNA polja za čitljiv prikaz na
        // računu (specifikacija #20) — stariji računi (pre P3.2) ih nemaju,
        // ticket-content/renderer to tretira kao "nema dodataka", ne kao grešku.
        items: payableItems.map((item) => {
          const modifierTotal = item.modifiers.reduce((sum, m) => sum.add(m.priceDelta), new Prisma.Decimal(0));
          return {
            name: item.name,
            price: item.price.toString(),
            basePrice: new Prisma.Decimal(item.price).sub(modifierTotal).toDecimalPlaces(2).toString(),
            modifiers: item.modifiers.map((m) => ({ name: m.optionName, priceDelta: m.priceDelta.toString() })),
            taxRate: item.taxRate.toString(),
            quantity: item.quantity,
            lineTotal: new Prisma.Decimal(item.price).mul(item.quantity).toDecimalPlaces(2).toString(),
          };
        }),
        taxBreakdown: taxBreakdown as never,
      },
    });

    // Sto se oslobađa ATOMSKI sa naplatom — nikad kao odvojen, ne-transakcioni
    // korak (zahtev specifikacije: "sto ne sme postati slobodan samo zato
    // što je neko zatvorio browser").
    const completionGuard = await tx.order.updateMany({
      where: { id: orderId, status: freshOrder.status },
      data: { status: "COMPLETED" },
    });
    if (completionGuard.count !== 1) throw new Error("Porudžbina je izmenjena u međuvremenu — naplata nije izvršena");
    await tx.restaurantTable.update({ where: { id: freshOrder.tableId }, data: { status: "FREE" } });

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
        locationId: freshOrder.locationId,
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

  // Receipt print job — dispatched AFTER commit, never fails the payment.
  try {
    await dispatchReceiptPrintJob(ctx, payment.id, {
      isReprint: false,
      dispatchKey: `receipt:${payment.id}`,
      requestedBy: ctx.employeeId,
    });
  } catch (err) {
    console.error("[printing] dispatchReceiptPrintJob failed for payment", payment.id, err);
  }

  return { order: await getOrder(ctx, orderId), payment, receipt };
}

export async function getReceipt(ctx: AuthContext, orderId: string) {
  requireOrderOperator(ctx);
  // Backwards-compatible order-level endpoint: with split bills there can be
  // several receipts, so return the newest one deterministically.
  const receipt = await prisma.receipt.findFirst({
    where: { orderId, ...scopeToRestaurant(ctx) },
    orderBy: [{ issuedAt: "desc" }, { sequenceNumber: "desc" }],
  });
  if (!receipt) throw new Error("Račun nije pronađen");
  requireLocationAccess(ctx, receipt.locationId);
  return receipt;
}
