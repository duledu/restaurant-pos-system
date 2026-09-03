/**
 * Faza 6 — štampa kuhinjskih/šank tiketa i kupčevog računa.
 *
 * ARHITEKTURA (zahtev specifikacije #6/#17 dela plana): PrintJob je
 * dispatch-tracking model, NIKAD novi izvor istine za rutiranje porudžbina
 * — OrderItemStation (Faza 1) ostaje jedini autoritativan mehanizam za to.
 * `dispatchStationPrintJobs`/`dispatchCancellationPrintJob`/
 * `dispatchReceiptPrintJob` se pozivaju TEK POSLE uspešnog commit-a
 * postojećih transakcija (submitOrder/voidOrderItem/completePayment),
 * uvek uvijeni u try/catch na mestu poziva — neuspeh štampe NIKAD ne sme
 * da obori/poništi poslovnu transakciju koja ga je izazvala.
 *
 * IDEMPOTENTNOST (zahtev #7, kritično): svaki dispatch upsertuje PrintJob
 * po `@@unique([orderId, dispatchKey])`. Ponovljen poziv (osvežena
 * stranica, retry, React re-render) sa istim dispatchKey-jem pogađa ISTI
 * red — nikad ne kreira drugi fizički otisak. Reprint svesno koristi NOV
 * dispatchKey (klijent generiše ključ po kliku, isti obrazac kao
 * Order.idempotencyKey) — svaki reprint je zaseban, auditovan red.
 */
import { prisma, Prisma } from "@rcs/db";
import { requireLocationAccess, requirePermission, scopeToRestaurant, ForbiddenError, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { getRestaurantSettings } from "../settings/settings-service";
import {
  buildKitchenBarTicketContent,
  buildCancellationTicketContent,
  buildReceiptTicketContent,
  shortOrderNumber,
  stationLabelFor,
  type Station,
} from "./ticket-content";
import { VOID_REASON_LABELS, type VoidReasonCode } from "@rcs/shared";

const ORDERS_PRINT = "orders.print";
const PRODUCTION_MANAGE = "production.manage";

function requirePrintAccess(ctx: AuthContext): void {
  if (ctx.permissions.has(ORDERS_PRINT) || ctx.permissions.has(PRODUCTION_MANAGE)) return;
  throw new ForbiddenError("Nemaš dozvolu za štampu");
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * P3.2: formatira dodatke za kuhinjski/šank/storno tiket kao gole stringove
 * — NIKAD cenu (postojeće pravilo, priprema ne treba da zna cenu). "+"
 * prefiks se određuje ovde na osnovu CENE (priceDelta > 0), ne parsiranjem
 * naziva opcije (specifikacija #52).
 */
function formatModifiersForTicket(modifiers: { optionName: string; priceDelta: Prisma.Decimal }[]): string[] {
  return modifiers.map((m) => (m.priceDelta.greaterThan(0) ? `+ ${m.optionName}` : m.optionName));
}

// ── DISPATCH (interno — pozvano iz order-service/void-service/billing-service
// POSLE commit-a njihovih transakcija, uvek u try/catch na mestu poziva) ──

/**
 * Kreira po jedan PrintJob za svaku stanicu (KUHINJA/ŠANK) koja ima sveže
 * poslate stavke za ovu porudžbinu. Poziva se iz submitOrder-a. Kuhinja
 * NIKAD ne dobija stavke šanka i obrnuto — grupisanje je direktno po
 * OrderItemStation.station (Faza 1 rutiranje), bez druge/paralelne logike.
 */
/**
 * VIŠE-KRUŽNO NARUČIVANJE: `options.orderItemIds`, kad je prosleđen,
 * ograničava tiket ISKLJUČIVO na te stavke (konkretan krug slanja) — bez
 * njega bi funkcija (kao ranije) pokupila SVAKI OrderItemStation red koji
 * je TRENUTNO u statusu SUBMITTED za celu porudžbinu, što bi za drugi/treći
 * krug moglo pogrešno pomešati stavke iz različitih krugova na isti tiket
 * (ili, gore, tiho preskočiti novi krug ako je dispatchKey iz prvog kruga
 * već zauzeo `orderId_dispatchKey` upsert). `options.dispatchKeySuffix`
 * postoji iz istog razloga — PRVO slanje zadržava tačan stari format
 * ključa (`submit:${station}`, potpuna unazadna kompatibilnost), naredni
 * krug dobija SVOJ, različit ključ (pozivalac prosleđuje idempotencyKey tog
 * zahteva) tako da svaki krug dobija sopstveni, odvojen tiket — nikad
 * duplikat, nikad tiho izgubljen.
 */
export async function dispatchStationPrintJobs(
  ctx: AuthContext,
  orderId: string,
  options?: { orderItemIds?: string[]; dispatchKeySuffix?: string }
): Promise<void> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...scopeToRestaurant(ctx) },
    include: { table: { select: { label: true } }, restaurant: { select: { name: true } } },
  });
  if (!order) return;

  const stationItems = await prisma.orderItemStation.findMany({
    where: {
      orderItem: { orderId },
      status: "SUBMITTED",
      ...(options?.orderItemIds ? { orderItemId: { in: options.orderItemIds } } : {}),
    },
    include: {
      orderItem: {
        select: { name: true, quantity: true, note: true, modifiers: { orderBy: { sortOrder: "asc" } } },
      },
    },
  });
  if (stationItems.length === 0) return;

  const waiter = await prisma.employee.findUnique({
    where: { id: order.openedBy },
    select: { firstName: true, lastName: true },
  });
  const waiterName = waiter ? `${waiter.firstName} ${waiter.lastName}` : "?";
  const orderNumber = shortOrderNumber(order.id);
  // "Sada" (dispatch se poziva odmah posle commit-a submitOrder-a), NE
  // Order.submittedAt — to je vreme PRVOG slanja cele porudžbine, pogrešno
  // za tiket bilo kog NAREDNOG kruga.
  const submittedAt = new Date().toISOString();

  const byStation = new Map<Station, typeof stationItems>();
  for (const row of stationItems) {
    const list = byStation.get(row.station);
    if (list) list.push(row);
    else byStation.set(row.station, [row]);
  }

  for (const [station, rows] of byStation) {
    const content = buildKitchenBarTicketContent({
      station,
      restaurantName: order.restaurant.name,
      tableLabel: order.table.label,
      waiterName,
      orderNumber,
      submittedAt,
      items: rows.map((r) => ({
        quantity: r.orderItem.quantity,
        name: r.orderItem.name,
        note: r.orderItem.note,
        modifiers: formatModifiersForTicket(r.orderItem.modifiers),
      })),
      // VIŠE-KRUŽNO NARUČIVANJE: dispatchKeySuffix je izostavljen ISKLJUČIVO
      // za prvo slanje (vidi order-service.ts submitOrder) — prisustvo
      // ovog argumenta je zato tačan, već postojeći signal da je ovo NAREDNI
      // (dodatni) krug, ne novi parametar koji treba posebno prosleđivati.
      isAdditional: Boolean(options?.dispatchKeySuffix),
    });
    const dispatchKey = options?.dispatchKeySuffix ? `submit:${station}:${options.dispatchKeySuffix}` : `submit:${station}`;
    await prisma.printJob.upsert({
      where: { orderId_dispatchKey: { orderId, dispatchKey } },
      create: {
        restaurantId: ctx.restaurantId,
        locationId: order.locationId,
        orderId,
        type: station,
        station,
        dispatchKey,
        content: toJson(content),
        requestedBy: ctx.employeeId,
      },
      update: {},
    });
  }
}

/**
 * STORNO tiket — samo za stanice koje su stvarno primile stavku (postojali
 * OrderItemStation redovi, sada CANCELLED usled voidOrderItem-a). Poziva
 * se iz voidOrderItem-a nakon commit-a, samo kad je void bio POTPUN (ista
 * grana koja u void-service.ts kaskadno otkazuje OrderItemStation redove —
 * delimično poništavanje ne generiše STORNO tiket jer priprema stavke i
 * dalje traje u umanjenoj količini).
 */
export async function dispatchCancellationPrintJob(ctx: AuthContext, orderItemVoidId: string): Promise<void> {
  const voidRecord = await prisma.orderItemVoid.findFirst({
    where: { id: orderItemVoidId, ...scopeToRestaurant(ctx) },
  });
  if (!voidRecord) return;

  const [stationRows, itemModifiers] = await Promise.all([
    prisma.orderItemStation.findMany({
      where: { orderItemId: voidRecord.orderItemId, status: "CANCELLED" },
    }),
    // P3.2: OrderItemModifier redovi ostaju vezani za OrderItem i posle void-a
    // (nikad se ne brišu) — dodaci moraju ostati vidljivi na storno tiketu
    // (specifikacija #24), bez potrebe za posebnim snapshot poljem na OrderItemVoid.
    prisma.orderItemModifier.findMany({ where: { orderItemId: voidRecord.orderItemId }, orderBy: { sortOrder: "asc" } }),
  ]);
  if (stationRows.length === 0) return;

  const reasonLabel = VOID_REASON_LABELS[voidRecord.reasonCode as VoidReasonCode] ?? voidRecord.reasonCode;
  const modifierLines = formatModifiersForTicket(itemModifiers);

  for (const row of stationRows) {
    const content = buildCancellationTicketContent({
      station: row.station,
      tableLabel: voidRecord.tableLabel,
      orderNumber: shortOrderNumber(voidRecord.orderId),
      voidedAt: voidRecord.voidedAt.toISOString(),
      items: [{ quantity: voidRecord.voidedQuantity, name: voidRecord.itemName, modifiers: modifierLines }],
      reasonLabel,
    });
    const dispatchKey = `void:${voidRecord.id}:${row.station}`;
    await prisma.printJob.upsert({
      where: { orderId_dispatchKey: { orderId: voidRecord.orderId, dispatchKey } },
      create: {
        restaurantId: ctx.restaurantId,
        locationId: voidRecord.locationId,
        orderId: voidRecord.orderId,
        type: row.station,
        station: row.station,
        dispatchKey,
        content: toJson(content),
        requestedBy: ctx.employeeId,
      },
      update: {},
    });
  }
}

/**
 * Kupčev račun — gradi se ISKLJUČIVO iz zamrznutog Receipt snapshot-a
 * (nikad iz Order/OrderItem uživo), ista konvencija kao Receipt sam.
 * `opts.dispatchKey` određuje da li je ovo prvobitna štampa ("receipt:...",
 * jedna po plaćanju) ili reprint ("receipt-reprint:...", nov ključ po
 * kliku — vidi napomenu na vrhu fajla).
 */
export async function dispatchReceiptPrintJob(
  ctx: AuthContext,
  paymentId: string,
  opts: { isReprint: boolean; dispatchKey: string; requestedBy: string }
): Promise<void> {
  const receipt = await prisma.receipt.findFirst({
    where: { paymentId, ...scopeToRestaurant(ctx) },
    include: { payment: true },
  });
  if (!receipt) return;

  const settings = await getRestaurantSettings(ctx);
  const items = receipt.items as unknown as {
    name: string;
    price: string;
    basePrice?: string;
    modifiers?: { name: string; priceDelta: string }[];
    taxRate: string;
    quantity: number;
    lineTotal: string;
  }[];
  const taxBreakdown = receipt.taxBreakdown as unknown as { taxRate: string; taxableAmount: string; taxAmount: string }[];

  const content = buildReceiptTicketContent({
    restaurantName: receipt.restaurantName,
    restaurantLegalName: receipt.restaurantLegalName,
    address: settings.address,
    phone: settings.phone,
    taxIdNumber: settings.taxIdNumber,
    legalNote: settings.receiptLegalNote,
    footerText: settings.receiptFooterText,
    receiptNumber: receipt.sequenceNumber,
    orderNumber: shortOrderNumber(receipt.orderId),
    tableLabel: receipt.tableLabel,
    waiterName: receipt.waiterName,
    issuedAt: receipt.issuedAt.toISOString(),
    items: items.map((i) => ({
      quantity: i.quantity,
      name: i.name,
      unitPrice: i.price,
      lineTotal: i.lineTotal,
      basePrice: i.basePrice,
      modifiers: i.modifiers,
    })),
    subtotal: receipt.subtotal.toString(),
    taxTotal: receipt.taxTotal.toString(),
    taxBreakdown,
    discountAmount: receipt.discountAmount ? receipt.discountAmount.toString() : null,
    total: receipt.total.toString(),
    currency: receipt.currency,
    paymentMethod: receipt.paymentMethod,
    tenderedAmount: receipt.payment.tenderedAmount.toString(),
    changeAmount: receipt.payment.changeAmount.toString(),
  });

  await prisma.printJob.upsert({
    where: { orderId_dispatchKey: { orderId: receipt.orderId, dispatchKey: opts.dispatchKey } },
    create: {
      restaurantId: ctx.restaurantId,
      locationId: receipt.locationId,
      orderId: receipt.orderId,
      type: "RECEIPT",
      station: null,
      dispatchKey: opts.dispatchKey,
      content: toJson(content),
      isReprint: opts.isReprint,
      requestedBy: opts.requestedBy,
    },
    update: {},
  });

  if (opts.isReprint) {
    await recordAuditEntry(ctx, {
      entityType: "Receipt",
      entityId: receipt.id,
      action: "receipt.reprinted",
      newValue: { paymentId, orderId: receipt.orderId },
      locationId: receipt.locationId,
    });
  }
}

// ── JAVNE FUNKCIJE (pozvane iz API ruta — eksplicitna provera dozvole) ──

async function loadOwnedOrder(ctx: AuthContext, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, ...scopeToRestaurant(ctx) } });
  if (!order) throw new Error("Porudžbina nije pronađena");
  requireLocationAccess(ctx, order.locationId);
  return order;
}

export async function listPrintJobs(ctx: AuthContext, orderId: string) {
  requirePrintAccess(ctx);
  await loadOwnedOrder(ctx, orderId);
  return prisma.printJob.findMany({
    where: { orderId, ...scopeToRestaurant(ctx) },
    orderBy: { createdAt: "desc" },
  });
}

async function loadOwnedPrintJob(ctx: AuthContext, orderId: string, printJobId: string) {
  const order = await loadOwnedOrder(ctx, orderId);
  const job = await prisma.printJob.findFirst({ where: { id: printJobId, orderId, ...scopeToRestaurant(ctx) } });
  if (!job) throw new Error("Print job nije pronađen");
  return { order, job };
}

/** Klijent (browser štampa) ili budući server-side adapter potvrđuje ishod. */
export async function confirmPrintResult(
  ctx: AuthContext,
  orderId: string,
  printJobId: string,
  result: { success: boolean; errorMessage?: string }
) {
  requirePrintAccess(ctx);
  const { job } = await loadOwnedPrintJob(ctx, orderId, printJobId);

  return prisma.printJob.update({
    where: { id: job.id },
    data: result.success
      ? { status: "PRINTED", printedAt: new Date(), attemptCount: { increment: 1 } }
      : { status: "FAILED", failureReason: result.errorMessage ?? "Nepoznata greška", attemptCount: { increment: 1 } },
  });
}

export async function retryPrintJob(ctx: AuthContext, orderId: string, printJobId: string) {
  requirePrintAccess(ctx);
  const { job } = await loadOwnedPrintJob(ctx, orderId, printJobId);
  if (job.status !== "FAILED") {
    throw new Error("Samo neuspeo pokušaj štampe može da se ponovi");
  }
  return prisma.printJob.update({ where: { id: job.id }, data: { status: "PENDING", failureReason: null } });
}

/**
 * Reprint kupčevog računa — NIKAD ne menja Order/Payment/Receipt niti bilo
 * koju prodajnu sumu (zahtev #6), samo ponovo generiše/vraća PrintJob za
 * ISTI zamrznuti Receipt. `idempotencyKey` generiše klijent po kliku (isti
 * obrazac kao Order.idempotencyKey) — retry MREŽE za isti klik je bezbedan
 * (upsert pogađa isti red), ali svaki NOV klik je zaseban, auditovan zapis.
 */
export async function reprintReceipt(ctx: AuthContext, orderId: string, idempotencyKey: string) {
  requirePermission(ctx, ORDERS_PRINT);
  await loadOwnedOrder(ctx, orderId);

  // The legacy order-level reprint action targets the newest receipt. Split
  // payments each have their own receipt, so the ordering must be explicit.
  const receipt = await prisma.receipt.findFirst({
    where: { orderId, ...scopeToRestaurant(ctx) },
    orderBy: [{ issuedAt: "desc" }, { sequenceNumber: "desc" }],
  });
  if (!receipt) throw new Error("Račun nije pronađen — porudžbina još nije naplaćena");

  const dispatchKey = `receipt-reprint:${receipt.paymentId}:${idempotencyKey}`;
  await dispatchReceiptPrintJob(ctx, receipt.paymentId, { isReprint: true, dispatchKey, requestedBy: ctx.employeeId });

  return prisma.printJob.findFirstOrThrow({ where: { orderId, dispatchKey } });
}

export { stationLabelFor };
