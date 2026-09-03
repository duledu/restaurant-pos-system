/**
 * FAZA 8 — SPLIT BILL (delimično plaćanje porudžbine po stavkama/količini).
 *
 * ARHITEKTURA: `Payment.orderId @unique` (MVP-only ograničenje najavljeno
 * još od Faze 2 — vidi schema.prisma) je uklonjen; jedan Order sada može
 * imati VIŠE Payment/Receipt redova, jedan po delimičnoj naplati.
 * `OrderItem.paidQuantity` prati koliko je od `quantity` već naplaćeno;
 * `PaymentItem` je alokacija koja tačno beleži koju količinu koje stavke je
 * pokrila koja Payment (zbir PaymentItem.quantity po orderItemId == tog
 * itema paidQuantity, održavano atomski u istoj transakciji).
 *
 * SPLIT-BY-AMOUNT (mod C iz specifikacije) je NAMERNO NEIMPLEMENTIRAN: čist
 * RSD iznos bez veze sa konkretnim stavkama ne može se bezbedno mapirati na
 * (a) koje tačno OrderItem količine su "plaćene" (bitno za preostali
 * prikaz/void/transfer), (b) koje DIRECT_STOCK/RECIPE količine treba
 * odbiti sa zaliha, (c) tačnu PDV stopu po stavci kad porudžbina ima
 * mešovite poreske stope. Split-po-stavkama/količini (ovaj fajl) je zato
 * jedini autoritativan model — amount-only split bi zahtevao proizvoljnu,
 * neproverljivu alokaciju iznosa na stavke, što specifikacija eksplicitno
 * zabranjuje kad je stavka-nivo alokacija potrebna za tačnost.
 *
 * POPUST: Order.discountAmount je FIKSAN iznos na nivou cele porudžbine
 * (Faza 6). Kod split plaćanja, svaka delimična uplata nosi svoj PRORATA
 * udeo (Payment.discountAmount) — poslednja uplata koja u potpunosti
 * zatvara porudžbinu UVEK preuzima TAČAN preostali iznos popusta (ne
 * proporcionalni razlomak) čime je zbir popusta preko svih Payment redova
 * jedne porudžbine UVEK tačno jednak Order.discountAmount, bez
 * zaokruživanja koje bi "procurilo". Vidi payDiscountShare() ispod.
 *
 * KONKURENTNOST — DVA SLOJA:
 *  1. Po-stavci guardovan `updateMany` (WHERE trenutna quantity/paidQuantity
 *     = pročitana vrednost) — ista odbrana kao void-service.ts/
 *     billing-service.ts, sprečava da dva konkurentna zahteva pokriju istu
 *     (ili preklapajuću) količinu iste stavke, i zatvara race sa
 *     konkurentnim void-om/transferom NAD TOM stavkom (koji ne zaključava
 *     Order red — vidi tačku 2).
 *  2. `SELECT ... FOR UPDATE` na Order redu, KAO PRVI upit unutar
 *     transakcije — serijalizuje SVE split-bill naplate ZA ISTU porudžbinu
 *     (konkurentni pozivi nad RAZLIČITIM porudžbinama se međusobno ne
 *     blokiraju, samo isti red). Ovo je NUŽNO za popust: da li je OVO
 *     plaćanje "poslednje" (i time treba da uzme TAČAN preostali popust,
 *     vidi napomenu o POPUSTU iznad) zavisi od stanja SVIH stavki
 *     porudžbine u tom trenutku — bez zaključavanja, dva konkurentna
 *     plaćanja za DVA RAZLIČITA artikla mogu svako (ispravno, iz sopstvene
 *     perspektive PRE nego što vidi ono drugo) zaključiti "nisam poslednje"
 *     i uzeti samo proporcionalni deo, ostavljajući ostatak popusta
 *     NIKAD dodeljen (SUM(Payment.discountAmount) < Order.discountAmount)
 *     — upravo scenario koji ANY snapshot pročitan PRE zaključavanja ne
 *     može pouzdano isključiti. `tx.order.updateMany(...)` u
 *     billing-service.completePayment/void-service.voidOrderItem/
 *     transfer-service.ts (kad zatvaraju porudžbinu) takođe implicitno
 *     zaključavaju isti red kroz obično UPDATE zaključavanje reda u
 *     Postgres-u, pa se ISPRAVNO serijalizuju NASUPROT ovoj funkciji bez
 *     ikakve izmene tamo. Kompletno zatvaranje porudžbine (status
 *     COMPLETED + oslobađanje stola) se sada dešava UNUTAR ISTE
 *     zaključane transakcije — nema više odvojenog "finalize" koraka posle
 *     commit-a, pa nema ni prozora u kom bi pad procesa između te dve
 *     tranzakcije ostavio potpuno naplaćenu porudžbinu otvorenom.
 */
import { prisma, Prisma } from "@rcs/db";
import { requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { ssePublisher } from "../realtime/sse-publisher";
import { getActiveShift } from "../shifts/shift-service";
import { getOrder } from "../orders/order-service";
import { requireOrderOperator, requireDraftOwnership } from "../orders/order-access";
import { computeOrderTotals } from "../orders/order-totals";
import { dispatchReceiptPrintJob } from "../printing/print-service";
import { validateAndDecrementInventoryInTx } from "../inventory/inventory-service";
import { validateAndDecrementIngredientsInTx } from "../inventory/ingredient-service";
import type { SplitBillPayInput } from "@rcs/shared";

const PAYABLE_STATUSES = new Set(["SUBMITTED", "ACCEPTED", "PREPARING", "READY", "SERVED"]);

type OrderWithItems = Prisma.OrderGetPayload<{
  include: { items: { include: { modifiers: true } }; table: true };
}>;
type OrderItemRow = OrderWithItems["items"][number];

async function loadOrderForSplit(ctx: AuthContext, orderId: string): Promise<OrderWithItems> {
  requireOrderOperator(ctx);
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...scopeToRestaurant(ctx) },
    include: { items: { include: { modifiers: { orderBy: { sortOrder: "asc" } } }, orderBy: { createdAt: "asc" } }, table: true },
  });
  if (!order) throw new Error("Porudžbina nije pronađena");
  requireLocationAccess(ctx, order.locationId);
  if (order.status === "DRAFT") requireDraftOwnership(ctx, order.openedBy);
  return order;
}

interface UnpaidLine {
  item: OrderItemRow;
  remaining: number;
}

/**
 * Neplaćen ostatak po stavci (isključuje CANCELLED, potpuno-plaćene redove,
 * I DRAFT stavke — VIŠE-KRUŽNO NARUČIVANJE, Faza 9: neposlat naredni krug
 * se ne naplaćuje kroz Split Bill dok se ne pošalje kuhinji/šanku, isti
 * razlog kao billing-service.getBillPreview/completePayment).
 */
function unpaidLines(order: OrderWithItems): UnpaidLine[] {
  return order.items
    .filter((item) => item.status !== "CANCELLED" && item.status !== "DRAFT")
    .map((item) => ({ item, remaining: item.quantity - item.paidQuantity }))
    .filter((line) => line.remaining > 0);
}

/**
 * Pregled za "Podeli račun" ekran — SVE neplaćene stavke (sa preostalom
 * količinom) + istorija dosadašnjih delimičnih uplata za ovu porudžbinu.
 * Iznosi se, kao i getBillPreview, RAČUNAJU IZNOVA iz trenutnog stanja na
 * svaki poziv — nikad se ne keširaju.
 */
export async function getSplitBillPreview(ctx: AuthContext, orderId: string) {
  const order = await loadOrderForSplit(ctx, orderId);
  const lines = unpaidLines(order);
  // VIŠE-KRUŽNO NARUČIVANJE: neposlata (DRAFT) stavka nikad nije na
  // računu (vidi unpaidLines), ali NJENO POSTOJANJE mora sprečiti da se
  // ekran prikaže kao "sve naplaćeno" — konobar mora prvo poslati ili
  // ukloniti tu stavku.
  const hasUnsentDraftItems = order.items.some((item) => item.status === "DRAFT");
  const totals = computeOrderTotals(
    lines.map((l) => ({ price: l.item.price, taxRate: l.item.taxRate, quantity: l.remaining })),
    0
  );

  const payments = await prisma.payment.findMany({
    where: { orderId },
    orderBy: { completedAt: "asc" },
    select: { id: true, method: true, amount: true, discountAmount: true, isSplit: true, completedBy: true, completedAt: true },
  });

  return {
    orderId: order.id,
    tableLabel: order.table.label,
    status: order.status,
    fullyPaid: lines.length === 0 && !hasUnsentDraftItems,
    hasUnsentDraftItems,
    items: lines.map((l) => ({
      orderItemId: l.item.id,
      name: l.item.name,
      unitPrice: l.item.price.toString(),
      quantity: l.item.quantity,
      paidQuantity: l.item.paidQuantity,
      remaining: l.remaining,
      modifiers: l.item.modifiers.map((m) => ({ optionName: m.optionName, priceDelta: m.priceDelta.toString() })),
    })),
    remainingSubtotal: totals.subtotal.toString(),
    remainingTax: totals.tax.toString(),
    payments: payments.map((p) => ({
      id: p.id,
      method: p.method,
      amount: p.amount.toString(),
      discountAmount: p.discountAmount ? p.discountAmount.toString() : null,
      isSplit: p.isSplit,
      completedBy: p.completedBy,
      completedAt: p.completedAt.toISOString(),
    })),
  };
}

export async function listOrderPayments(ctx: AuthContext, orderId: string) {
  const order = await loadOrderForSplit(ctx, orderId);
  return prisma.payment.findMany({
    where: { orderId: order.id },
    orderBy: { completedAt: "asc" },
    include: { receipt: { select: { id: true, sequenceNumber: true } } },
  });
}

/**
 * Delimično plaćanje — konobar bira KOJE stavke (i koje količine) ovaj
 * gost plaća. Sme se pozvati proizvoljan broj puta na istoj porudžbini dok
 * god ima neplaćenog ostatka; poziv koji pokrije SVE preostale količine
 * zatvara porudžbinu (u ISTOJ transakciji, vidi napomenu o konkurentnosti
 * na vrhu fajla).
 */
export async function paySplitBill(ctx: AuthContext, orderId: string, input: SplitBillPayInput) {
  // Idempotency PRE teškog posla — isti obrazac kao submitOrder. Ako je
  // ključ već upotrebljen za ovu porudžbinu, ovo je retry (duplo kliknuto
  // dugme, mrežni retry) — vrati već postojeći rezultat, nikad ne naplati
  // dvaput.
  const existingPayment = await prisma.payment.findFirst({ where: { orderId, idempotencyKey: input.idempotencyKey } });
  if (existingPayment) {
    const existingReceipt = await prisma.receipt.findFirst({ where: { paymentId: existingPayment.id } });
    const orderNow = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    return {
      order: await getOrder(ctx, orderId),
      payment: existingPayment,
      receipt: existingReceipt,
      isFinalPayment: orderNow.status === "COMPLETED",
    };
  }

  // Brza (ne-konkurentna) validacija PRE otvaranja transakcije/zaključavanja
  // — odbacuje očigledno neispravan zahtev (nepostojeća stavka, porudžbina
  // koja uopšte nije poslata, itd.) bez cene zauzimanja Order reda.
  // AUTORITATIVNA validacija (i JEDINI izvor za popust/isFinalPayment) je
  // ONA UNUTAR transakcije ispod, nad SVEŽE pročitanim (zaključanim) stanjem.
  const order = await loadOrderForSplit(ctx, orderId);
  if (order.status === "COMPLETED") throw new Error("Porudžbina je već naplaćena");
  if (order.status === "CANCELLED") throw new Error("Porudžbina je otkazana");
  if (!PAYABLE_STATUSES.has(order.status)) throw new Error("Porudžbina još nije poslata — nema šta da se naplati");

  const requestedByItem = new Map<string, number>();
  for (const line of input.lines) {
    if (requestedByItem.has(line.orderItemId)) throw new Error("Dupliran red u zahtevu za istu stavku");
    requestedByItem.set(line.orderItemId, line.quantity);
  }
  if (requestedByItem.size === 0) throw new Error("Nema izabranih stavki za naplatu");

  // Smena/restoran/konobar se učitavaju PRE transakcije (isti obrazac kao
  // billing-service.completePayment) — ne zavise od zaključanog stanja
  // stavki, nema razloga da drže Order red zaključan duže nego što mora.
  const shift = await getActiveShift(ctx, order.locationId);
  if (!shift) throw new Error("Nema aktivne smene na ovoj lokaciji — plaćanje nije moguće");
  const [restaurant, waiter] = await Promise.all([
    prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } }),
    prisma.employee.findUnique({ where: { id: order.openedBy }, select: { firstName: true, lastName: true } }),
  ]);

  const created = await prisma.$transaction(async (tx) => {
    // KRITIČNO — MORA biti PRVI upit koji dotiče Order red u ovoj
    // transakciji: zaključava red do commit-a, serijalizujući SVAKU drugu
    // split-bill naplatu (i svaki completePayment/void/transfer koji menja
    // isti Order red preko običnog UPDATE-a) NAD ISTOM porudžbinom. Vidi
    // opširnu napomenu o konkurentnosti na vrhu fajla — ovo je jedini način
    // da se popust ispravno alocira kad dva RAZLIČITA artikla budu plaćena
    // od strane dva konkurentna poziva.
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;

    // The optimistic check above can miss a truly concurrent retry. Recheck
    // after acquiring the order lock so the second request observes the
    // committed payment and returns it instead of failing validation.
    const concurrentRetry = await tx.payment.findFirst({
      where: { orderId, idempotencyKey: input.idempotencyKey },
      include: { receipt: true, order: { select: { status: true, locationId: true, tableId: true } } },
    });
    if (concurrentRetry) {
      return {
        payment: concurrentRetry,
        receipt: concurrentRetry.receipt,
        isFinalPayment: concurrentRetry.order.status === "COMPLETED",
        locationId: concurrentRetry.order.locationId,
        tableId: concurrentRetry.order.tableId,
        isRetry: true,
      };
    }

    // SVEŽE (zaključano) stanje — jedini izvor istine za validaciju, popust
    // i "da li je ovo poslednje plaćanje" ispod. Nikad se ne koristi `order`
    // pročitan PRE transakcije za bilo šta finansijski osetljivo.
    const freshOrder = await tx.order.findFirst({
      where: { id: orderId },
      include: { items: { include: { modifiers: { orderBy: { sortOrder: "asc" } } }, orderBy: { createdAt: "asc" } }, table: true },
    });
    if (!freshOrder) throw new Error("Porudžbina nije pronađena");
    if (freshOrder.status === "COMPLETED") throw new Error("Porudžbina je već naplaćena");
    if (freshOrder.status === "CANCELLED") throw new Error("Porudžbina je otkazana");
    if (!PAYABLE_STATUSES.has(freshOrder.status)) throw new Error("Porudžbina još nije poslata — nema šta da se naplati");

    const freshItemById = new Map(freshOrder.items.map((i) => [i.id, i]));
    const payLines: Array<{ item: OrderItemRow; quantity: number }> = [];
    for (const [itemId, quantity] of requestedByItem) {
      const item = freshItemById.get(itemId);
      if (!item) throw new Error("Stavka ne pripada ovoj porudžbini");
      if (item.status === "CANCELLED") throw new Error(`Stavka "${item.name}" je poništena i ne može se naplatiti`);
      const remaining = item.quantity - item.paidQuantity;
      if (quantity > remaining) {
        throw new Error(`Tražena količina za "${item.name}" (${quantity}) je veća od neplaćenog ostatka (${remaining})`);
      }
      payLines.push({ item, quantity });
    }

    const { subtotal, tax } = computeOrderTotals(
      payLines.map((l) => ({ price: l.item.price, taxRate: l.item.taxRate, quantity: l.quantity })),
      0
    );

    // Da li OVO plaćanje pokriva SVAKU preostalu neplaćenu količinu na
    // porudžbini — SVEŽE i pod zaključanim redom, pa je pouzdano (nijedna
    // druga split naplata za OVU porudžbinu nije mogla biti "u letu" dok
    // ovde stojimo, vidi napomenu na vrhu fajla).
    //
    // VIŠE-KRUŽNO NARUČIVANJE (Faza 9): `unpaidLines` (iznad) NAMERNO
    // isključuje DRAFT stavke (neposlat naredni krug se ne naplaćuje) — ali
    // NJIHOVO POSTOJANJE mora i dalje sprečiti da se porudžbina proglasi
    // "u potpunosti naplaćena" ("Order closes only when ... no active
    // unsent items remain"). Bez ove eksplicitne provere, plaćanje koje
    // pokrije SVE poslate stavke bi zatvorilo porudžbinu dok neposlata
    // stavka ostane osirotela (porudžbina zatvorena, stavka se više ne
    // može ni poslati ni ukloniti).
    const hasUnsentDraftItems = freshOrder.items.some((item) => item.status === "DRAFT");
    const freshUnpaid = unpaidLines(freshOrder);
    const isFinalPayment = !hasUnsentDraftItems && freshUnpaid.every((l) => (requestedByItem.get(l.item.id) ?? 0) >= l.remaining);

    // Popust: prorata na osnovu SVEŽE sume već potrošenog popusta (upit nad
    // istom zaključanom porudžbinom — nijedna druga naplata ga nije mogla
    // promeniti dok mi držimo red). Poslednje plaćanje UVEK uzima TAČAN
    // ostatak (nikad razlomak) — garantuje SUM(Payment.discountAmount) ==
    // Order.discountAmount čim je porudžbina u potpunosti naplaćena, bez
    // obzira na broj/redosled/konkurentnost prethodnih delimičnih naplata.
    let discountShare = new Prisma.Decimal(0);
    const fullOrderDiscount = new Prisma.Decimal(freshOrder.discountAmount ?? 0);
    if (!fullOrderDiscount.isZero()) {
      const priorDiscount = await tx.payment.aggregate({ where: { orderId }, _sum: { discountAmount: true } });
      const discountConsumed = new Prisma.Decimal(priorDiscount._sum.discountAmount ?? 0);
      const discountRemaining = Prisma.Decimal.max(fullOrderDiscount.sub(discountConsumed), 0);
      if (isFinalPayment) {
        discountShare = discountRemaining;
      } else {
        const remainingSubtotalAll = computeOrderTotals(
          freshUnpaid.map((l) => ({ price: l.item.price, taxRate: l.item.taxRate, quantity: l.remaining })),
          0
        ).subtotal;
        if (!remainingSubtotalAll.isZero()) {
          discountShare = discountRemaining.mul(subtotal).div(remainingSubtotalAll).toDecimalPlaces(2);
        }
      }
    }

    const { total, taxBreakdown } = computeOrderTotals(
      payLines.map((l) => ({ price: l.item.price, taxRate: l.item.taxRate, quantity: l.quantity })),
      discountShare
    );
    if (total.isNegative()) throw new Error("Iznos naplate ne može biti negativan — proveri popust");

    let tenderedAmount = total;
    let changeAmount = new Prisma.Decimal(0);
    if (input.method === "CASH" && input.tenderedAmount !== undefined) {
      tenderedAmount = new Prisma.Decimal(input.tenderedAmount);
      if (tenderedAmount.lessThan(total)) throw new Error("Primljena gotovina je manja od ukupnog iznosa računa");
      changeAmount = tenderedAmount.sub(total);
    }

    // Po-stavci guard: dodatna (redundantna sa Order-nivo zaključavanjem,
    // ali jeftina) odbrana protiv konkurentnog void-a/transfera NAD ISTOM
    // stavkom — te operacije ne zaključavaju Order red, samo konkretan
    // OrderItem red, pa se serijalizuju kroz OVAJ guard, ne kroz gornji lock.
    for (const { item, quantity } of payLines) {
      const guard = await tx.orderItem.updateMany({
        where: { id: item.id, quantity: item.quantity, paidQuantity: item.paidQuantity, status: { not: "CANCELLED" } },
        data: { paidQuantity: { increment: quantity } },
      });
      if (guard.count !== 1) {
        throw new Error(`Stavka "${item.name}" je izmenjena u međuvremenu (naplaćena/poništena/prebačena) — osveži prikaz i pokušaj ponovo`);
      }
    }

    const paymentRow = await tx.payment.create({
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
        idempotencyKey: input.idempotencyKey,
        discountAmount: discountShare.isZero() ? null : discountShare,
        isSplit: true,
      },
    });

    await tx.paymentItem.createMany({
      data: payLines.map(({ item, quantity }) => ({
        paymentId: paymentRow.id,
        orderItemId: item.id,
        quantity,
        unitPrice: item.price,
        taxRate: item.taxRate,
        lineTotal: new Prisma.Decimal(item.price).mul(quantity).toDecimalPlaces(2),
      })),
    });

    // Zaliha se odbija SAMO za količine plaćene U OVOJ uplati — nikad za
    // ceo item.quantity (to bi dvostruko odbilo već naplaćeni deo).
    await validateAndDecrementInventoryInTx(tx, {
      paymentId: paymentRow.id,
      orderId,
      restaurantId: ctx.restaurantId,
      locationId: freshOrder.locationId,
      items: payLines.map(({ item, quantity }) => ({ menuItemId: item.menuItemId, quantity })),
    });
    await validateAndDecrementIngredientsInTx(tx, {
      paymentId: paymentRow.id,
      orderId,
      restaurantId: ctx.restaurantId,
      locationId: freshOrder.locationId,
      items: payLines.map(({ item, quantity }) => ({ menuItemId: item.menuItemId, quantity })),
    });

    const receiptRow = await tx.receipt.create({
      data: {
        orderId,
        paymentId: paymentRow.id,
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
        discountAmount: discountShare.isZero() ? null : discountShare,
        items: payLines.map(({ item, quantity }) => {
          const modifierTotal = item.modifiers.reduce((sum, m) => sum.add(m.priceDelta), new Prisma.Decimal(0));
          return {
            name: item.name,
            price: item.price.toString(),
            basePrice: new Prisma.Decimal(item.price).sub(modifierTotal).toDecimalPlaces(2).toString(),
            modifiers: item.modifiers.map((m) => ({ name: m.optionName, priceDelta: m.priceDelta.toString() })),
            taxRate: item.taxRate.toString(),
            quantity,
            lineTotal: new Prisma.Decimal(item.price).mul(quantity).toDecimalPlaces(2).toString(),
          };
        }),
        taxBreakdown: taxBreakdown as never,
      },
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        type: "split_payment_completed",
        createdBy: ctx.employeeId,
        payload: {
          paymentId: paymentRow.id,
          method: input.method,
          amount: total.toString(),
          lines: payLines.map(({ item, quantity }) => ({ itemId: item.id, name: item.name, quantity })),
        },
      },
    });

    await recordAuditEntry(
      ctx,
      {
        entityType: "Order",
        entityId: orderId,
        action: "payment.split_completed",
        newValue: { paymentId: paymentRow.id, method: input.method, amount: total.toString(), receiptId: receiptRow.id },
        locationId: freshOrder.locationId,
      },
      tx
    );

    // Zatvaranje porudžbine (kad je SVE plaćeno) se dešava OVDE, U ISTOJ
    // zaključanoj transakciji — `isFinalPayment` je gore izračunat pod
    // zaključavanjem, pa je pouzdan bez obzira na konkurentne pozive nad
    // RAZLIČITIM artiklima iste porudžbine (vidi napomenu na vrhu fajla).
    if (isFinalPayment) {
      await tx.order.update({ where: { id: orderId }, data: { status: "COMPLETED" } });
      await tx.restaurantTable.update({ where: { id: freshOrder.tableId }, data: { status: "FREE" } });
      await tx.orderEvent.create({
        data: { orderId, type: "order_fully_settled", createdBy: ctx.employeeId, payload: { via: "split_bill" } },
      });
    }

    return { payment: paymentRow, receipt: receiptRow, isFinalPayment, locationId: freshOrder.locationId, tableId: freshOrder.tableId, isRetry: false };
  });

  if (!created.isRetry) {
    await ssePublisher.publish({
      type: "payment.completed",
      restaurantId: ctx.restaurantId,
      locationId: created.locationId,
      payload: { orderId, tableId: created.tableId },
      occurredAt: new Date().toISOString(),
    });

    try {
      await dispatchReceiptPrintJob(ctx, created.payment.id, {
        isReprint: false,
        dispatchKey: `receipt:${created.payment.id}`,
        requestedBy: ctx.employeeId,
      });
    } catch (err) {
      console.error("[printing] dispatchReceiptPrintJob failed for split payment", created.payment.id, err);
    }
  }

  return {
    order: await getOrder(ctx, orderId),
    payment: created.payment,
    receipt: created.receipt,
    isFinalPayment: created.isFinalPayment,
  };
}
