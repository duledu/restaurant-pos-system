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
import { randomUUID } from "node:crypto";
import { lockPrintLocation, stationPolicy, activeWorkstationFor } from "./print-policy";
import { requireLocationAccess, requirePermission, scopeToRestaurant, ForbiddenError, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { getRestaurantSettings, getPrinterConfigForDispatch } from "../settings/settings-service";
import { assertStationAccess } from "../production/production-service";
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
        select: { name: true, quantity: true, note: true, submittedAt: true, modifiers: { orderBy: { sortOrder: "asc" } } },
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
    await prisma.$transaction(async (tx) => {
      await lockPrintLocation(tx, ctx.restaurantId, order.locationId);
      // Print Agent spremnost je AUTORITATIVNA za normalan (automatski) put
      // — legacy Browser/QZ "Automatska štampa novih porudžbina"/isEnabled
      // NIKAD ne sme tiho blokirati kreiranje automatskog PrintJob-a dok je
      // paren, spreman Print Agent za TAČNO ovu stanicu (agent poll/claim,
      // agentPrinting.pollAndClaim, tu proveru uopšte ne čita). Legacy
      // podešavanje ostaje relevantno SAMO kad agent NIJE aktivan (ručni/
      // rezervni Browser/QZ put). Širina papira: agent-prijavljena vrednost
      // kad je agent aktivan (jedini "vlasnik" te vrednosti za tu stanicu),
      // inače legacy PrinterConfig snapshot kao pre (zahtev #10/#17).
      const activeWorkstation = await activeWorkstationFor(tx, ctx.restaurantId, order.locationId, station);
      let paperWidthMm: number;
      if (activeWorkstation) {
        paperWidthMm = activeWorkstation.paperWidthMm ?? 80;
      } else {
        const policy = await stationPolicy(tx, ctx.restaurantId, order.locationId, station);
        const eventAt = new Date(Math.min(...rows.map((r) => (r.orderItem.submittedAt ?? order.submittedAt ?? new Date(0)).getTime())));
        if (!policy.isEnabled || !policy.autoPrint || (policy.automaticSince && eventAt <= policy.automaticSince)) return;
        paperWidthMm = policy.paperWidthMm;
      }
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
        paperWidthMm,
      });
      const dispatchKey = options?.dispatchKeySuffix ? `submit:${station}:${options.dispatchKeySuffix}` : `submit:${station}`;
      await tx.printJob.upsert({
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
          isAutomatic: true,
        },
        update: {},
      });
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
    await prisma.$transaction(async (tx) => {
      await lockPrintLocation(tx, ctx.restaurantId, voidRecord.locationId);
      // Isto pravilo kao dispatchStationPrintJobs iznad — Print Agent
      // spremnost je autoritativna za normalan (automatski) STORNO tiket;
      // legacy podešavanje važi samo kad agent nije aktivan.
      const activeWorkstation = await activeWorkstationFor(tx, ctx.restaurantId, voidRecord.locationId, row.station);
      let paperWidthMm: number;
      if (activeWorkstation) {
        paperWidthMm = activeWorkstation.paperWidthMm ?? 80;
      } else {
        const policy = await stationPolicy(tx, ctx.restaurantId, voidRecord.locationId, row.station);
        if (!policy.isEnabled || !policy.autoPrint || (policy.automaticSince && voidRecord.voidedAt <= policy.automaticSince)) return;
        paperWidthMm = policy.paperWidthMm;
      }
      const content = buildCancellationTicketContent({
        station: row.station,
        tableLabel: voidRecord.tableLabel,
        orderNumber: shortOrderNumber(voidRecord.orderId),
        voidedAt: voidRecord.voidedAt.toISOString(),
        items: [{ quantity: voidRecord.voidedQuantity, name: voidRecord.itemName, modifiers: modifierLines }],
        reasonLabel,
        paperWidthMm,
      });
      const dispatchKey = `void:${voidRecord.id}:${row.station}`;
      await tx.printJob.upsert({
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
          isAutomatic: true,
        },
        update: {},
      });
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

  // RECEIPT RENDERING POLISH — historical accuracy on reprint (audit
  // finding, not previously covered by any test): PrintJob.content's own
  // doc comment in schema.prisma promises reprint "NIKAD ne preračunava"
  // (never recomputes), but this function used to rebuild `content` fresh
  // from LIVE RestaurantSettings (address/phone/PIB/footer/legal
  // note/showTaxBreakdown) on EVERY call, including every explicit reprint
  // — so if Admin edited any of those fields (or the new VAT-display
  // toggle) between the original transaction and a later reprint, the
  // reprint would silently show the NEW values, not what was true when the
  // sale actually happened. Fix: a reprint (any dispatchKey other than the
  // ORIGINAL automatic one) now looks up that original PrintJob row and
  // reuses its `content` JSON completely unchanged — the exact same
  // "replay the frozen snapshot" contract already used for KITCHEN/BAR.
  // Falls through to building fresh content only when no original row
  // exists yet (e.g. the automatic dispatch itself failed before ever
  // creating one — this reprint click is then effectively the first-ever
  // dispatch) or when this call IS that original dispatch itself.
  const originalDispatchKey = `receipt:${paymentId}`;
  const original =
    opts.dispatchKey === originalDispatchKey
      ? null
      : await prisma.printJob.findUnique({
          where: { orderId_dispatchKey: { orderId: receipt.orderId, dispatchKey: originalDispatchKey } },
        });

  let content: ReturnType<typeof buildReceiptTicketContent>;
  if (original) {
    content = original.content as unknown as ReturnType<typeof buildReceiptTicketContent>;
  } else {
    // Physical PREPROD root cause (real receipt #425, POS-58 — "Driver
    // printable area is too small for this ticket.", reproduced exactly by
    // rendering this receipt's real content at 80mm against the SAME driver
    // family test_11 uses): this UNCONDITIONALLY read the legacy Browser/QZ
    // PrinterConfig default (80mm, since no PrinterConfig row exists for a
    // restaurant fully on the Printing V2 WorkstationPrintRoute model) instead
    // of the REAL Agent-configured RECEIPT route (58mm) — the exact same class
    // of bug dispatchStationPrintJobs (KITCHEN/BAR, below) already correctly
    // avoids by preferring the active Agent workstation's own reported
    // paperWidthMm first, only falling back to legacy PrinterConfig when no
    // Agent is active at all. RECEIPT was never given the same treatment when
    // it became Agent-routable. The ticket was then frozen with the WRONG
    // width, and AgentRunner.cs's own (now-removed) override compounded this
    // by letting that wrong value replace the Agent's correct local route
    // width — this fix removes the root cause at its source; the paired Agent
    // fix (see AgentRunner.cs ProcessReceivedJob) removes the second, unsafe
    // "trust the server's embedded width over local config" layer too.
    const [settings, activeWorkstation] = await Promise.all([
      getRestaurantSettings(ctx),
      activeWorkstationFor(prisma, ctx.restaurantId, receipt.locationId, "RECEIPT"),
    ]);
    const paperWidthMm = activeWorkstation
      ? (activeWorkstation.paperWidthMm ?? 80)
      : (await getPrinterConfigForDispatch(ctx.restaurantId, receipt.locationId, "RECEIPT")).paperWidthMm;
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

    content = buildReceiptTicketContent({
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
      showTaxBreakdown: settings.showTaxBreakdown,
      discountAmount: receipt.discountAmount ? receipt.discountAmount.toString() : null,
      total: receipt.total.toString(),
      currency: receipt.currency,
      paymentMethod: receipt.paymentMethod,
      tenderedAmount: receipt.payment.tenderedAmount.toString(),
      changeAmount: receipt.payment.changeAmount.toString(),
      paperWidthMm,
    });
  }

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
      // PRINTING V2 FINAL — physical PREPROD root cause: this was left at
      // the schema default (false), same as a MANUAL KITCHEN/BAR
      // reprint (requestStationPrint) — correct for that case (a KDS
      // operator's own browser is expected to claim it), but WRONG here.
      // agentPrinting.pollAndClaim's candidate query filters
      // `isAutomatic: true` (mirroring dispatchStationPrintJobs's
      // KITCHEN/BAR automatic dispatch below) — with this left false,
      // EVERY receipt PrintJob (both the automatic payment-time dispatch
      // and the new silent printing.printReceipt primary action) was
      // structurally invisible to the Agent's own poll forever, only ever
      // reachable by an employee's own browser manually claiming it
      // (printAndConfirm/beginPrintJob). That is exactly the observed bug:
      // the waiter UI correctly reported "sent" (the job genuinely exists),
      // but no Agent ever printed it. RECEIPT now dispatches automatic
      // exactly like KITCHEN/BAR.
      isAutomatic: true,
      isReprint: opts.isReprint,
      reprintOfId: original?.id ?? null,
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
  result: { attemptId: string; outcome: "TRANSPORT_COMPLETED" | "SUBMITTED_TO_SPOOLER" | "FAILED_BEFORE_SUBMISSION" | "SUBMISSION_UNKNOWN"; errorMessage?: string }
) {
  requirePrintAccess(ctx);
  const { job } = await loadOwnedPrintJob(ctx, orderId, printJobId);
  if (job.station) assertStationAccess(ctx, job.station);
  if (!["TRANSPORT_COMPLETED", "SUBMITTED_TO_SPOOLER", "FAILED_BEFORE_SUBMISSION", "SUBMISSION_UNKNOWN"].includes(result.outcome)) throw new Error("Invalid print outcome");
  return prisma.$transaction(async (tx) => {
    await lockPrintLocation(tx, ctx.restaurantId, job.locationId);
    const current = await tx.printJob.findUniqueOrThrow({ where: { id: job.id } });
    if (!result.attemptId || current.attemptId !== result.attemptId || current.claimedBy !== ctx.employeeId) throw new Error("Stale print attempt");
    if (current.resultOutcome) {
      if (current.resultOutcome === result.outcome) return current;
      throw new Error("Print result already finalized");
    }
    if (current.status !== "PRINTING" && current.status !== "SUBMISSION_UNKNOWN") throw new Error("Print attempt is not active");
    if (result.outcome !== "FAILED_BEFORE_SUBMISSION" && !current.submissionStartedAt) throw new Error("Submission was not started");
    const updated = await tx.printJob.update({ where: { id: job.id }, data: {
      status: (result.outcome === "SUBMITTED_TO_SPOOLER" || result.outcome === "TRANSPORT_COMPLETED") ? "PRINTED" : result.outcome === "FAILED_BEFORE_SUBMISSION" ? "FAILED" : "SUBMISSION_UNKNOWN",
      resultOutcome: result.outcome,
      printedAt: (result.outcome === "SUBMITTED_TO_SPOOLER" || result.outcome === "TRANSPORT_COMPLETED") ? new Date() : null,
      failureReason: (result.outcome === "SUBMITTED_TO_SPOOLER" || result.outcome === "TRANSPORT_COMPLETED") ? null : result.errorMessage?.slice(0, 500) ?? result.outcome,
    } });
    await recordAuditEntry(ctx, { entityType: "PrintJob", entityId: job.id, action: "print.result",
      newValue: { attemptId: result.attemptId, outcome: result.outcome }, locationId: job.locationId }, tx);
    return updated;
  });
}

export async function retryPrintJob(ctx: AuthContext, orderId: string, printJobId: string) {
  requirePrintAccess(ctx);
  const { job } = await loadOwnedPrintJob(ctx, orderId, printJobId);
  if (job.station) assertStationAccess(ctx, job.station);
  return prisma.$transaction(async (tx) => {
    await lockPrintLocation(tx, ctx.restaurantId, job.locationId);
    // Found during hardening audit ("Pokušaj ponovo" trace): forcing
    // isAutomatic:false unconditionally made sense ONLY for the old
    // Browser/QZ world, where "manual retry" meant "this exact browser
    // click prints it right now" — that's also what let retry bypass a
    // legacy autoPrint=false toggle (beginPrintAttempt only gates on the
    // OFF switch when isAutomatic is true). For an Agent-routed station,
    // the KDS operator's OWN browser/device is almost never the physical
    // printer — forcing isAutomatic:false there permanently hides the job
    // from agentPrinting.pollAndClaim (which only polls isAutomatic:true),
    // so retry would silently never reach the real Kitchen/Bar printer.
    // When a live Agent owns this station, keep isAutomatic as it already
    // is (normally true for a failed automatic dispatch) so the Agent's
    // own fast poll (~1-3s) naturally reclaims it — beginPrintAttempt's
    // legacy gate is already bypassed for this case (see fix above).
    // Fallback stations (no active Agent) keep the exact original
    // behavior — isAutomatic:false, immediate manual claim by the caller.
    const activeWorkstation = await activeWorkstationFor(tx, ctx.restaurantId, job.locationId, job.type);
    const changed = await tx.printJob.updateMany({
      where: { id: job.id, status: "FAILED", resultOutcome: "FAILED_BEFORE_SUBMISSION" },
      data: { status: "PENDING", failureReason: null, attemptId: null, claimedBy: null, claimedAt: null,
        submissionStartedAt: null, resultOutcome: null, ...(activeWorkstation ? {} : { isAutomatic: false }) },
    });
    if (!changed.count) throw new Error("Samo neuspeo pokušaj pre slanja može da se ponovi; neizvestan ishod zahteva novi otisak");
    await recordAuditEntry(ctx, { entityType: "PrintJob", entityId: job.id, action: "print.retry_requested",
      previousValue: { isAutomatic: job.isAutomatic, attemptId: job.attemptId }, locationId: job.locationId }, tx);
    return tx.printJob.findUniqueOrThrow({ where: { id: job.id } });
  });
}

/** Atomic claim; attemptCount is owned only by this successful transition. */
export async function beginPrintAttempt(ctx: AuthContext, orderId: string, printJobId: string) {
  requirePrintAccess(ctx);
  const { job } = await loadOwnedPrintJob(ctx, orderId, printJobId);
  if (job.station) assertStationAccess(ctx, job.station);

  return prisma.$transaction(async (tx) => {
    await lockPrintLocation(tx, ctx.restaurantId, job.locationId);
    // Problem 2 fix follow-up (found during hardening audit): dispatch/
    // suppression already bypass legacy PrinterConfig when a live Print
    // Agent workstation exists (activeWorkstationFor) — but the ACTUAL
    // claim step below did NOT, meaning a paired, ready Agent's own
    // pollAndClaim (which calls THIS function) could still be silently
    // refused a job it should serve, purely because of an unrelated
    // Browser/QZ toggle. `policy === null` below means "an active agent
    // owns this station — skip legacy gates entirely", exactly mirroring
    // dispatchStationPrintJobs's rule.
    //
    // PRINTING V2 FINAL fix — this used to be `job.station ? ... : null`.
    // `job.station` (legacy ProductionStation) is ALWAYS null for RECEIPT by
    // design, so that gate NEVER consulted Agent eligibility for a RECEIPT
    // job — it silently fell through to legacy Browser/QZ PrinterConfig
    // policy every time, regardless of whether a live, route-configured
    // Agent existed. `job.type` (KITCHEN|BAR|RECEIPT) is always populated
    // and is the correct, mode-aware key (activeWorkstationFor now also
    // honors LOGIN_AWARE terminal binding and CENTRAL_ROUTING's
    // deterministic primary selection — see print-policy.ts).
    const activeWorkstation = await activeWorkstationFor(tx, ctx.restaurantId, job.locationId, job.type);
    const policy = activeWorkstation ? null : await stationPolicy(tx, ctx.restaurantId, job.locationId, job.type);
    if (policy && !policy.isEnabled) return null;
    // Also recover an individual manual/receipt claim without requiring KDS polling.
    await tx.printJob.updateMany({ where: { id: job.id, status: "PRINTING", attemptId: { not: null }, submissionStartedAt: null,
      claimedAt: { lt: new Date(Date.now() - STALE_PRINT_LEASE_MS) } },
      data: { status: "PENDING", attemptId: null, claimedBy: null, claimedAt: null } });
    const current = await tx.printJob.findUniqueOrThrow({ where: { id: job.id } });
    if (policy && current.isAutomatic && !policy.autoPrint) return null;
    const claimed = await tx.printJob.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: { status: "PRINTING", attemptId: randomUUID(), claimedBy: ctx.employeeId, claimedAt: new Date(),
        submissionStartedAt: null, resultOutcome: null, attemptCount: { increment: 1 } },
    });
    if (!claimed.count) return null;
    const attempt = await tx.printJob.findUniqueOrThrow({ where: { id: job.id } });
    await recordAuditEntry(ctx, { entityType: "PrintJob", entityId: job.id, action: "print.claimed",
      newValue: { attemptId: attempt.attemptId, attemptCount: attempt.attemptCount }, locationId: job.locationId }, tx);
    return attempt;
  });
}

/** One-shot permission to invoke a transport. A lost response is NOT permission to retry. */
export async function startPrintSubmission(ctx: AuthContext, orderId: string, printJobId: string, attemptId: string) {
  requirePrintAccess(ctx);
  if (typeof attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)) throw new Error("Invalid print attempt");
  const { job } = await loadOwnedPrintJob(ctx, orderId, printJobId);
  if (job.station) assertStationAccess(ctx, job.station);
  return prisma.$transaction(async (tx) => {
    await lockPrintLocation(tx, ctx.restaurantId, job.locationId);
    // Same rule as beginPrintAttempt above — an active Print Agent
    // workstation makes legacy PrinterConfig irrelevant for this station.
    const activeWorkstation = await activeWorkstationFor(tx, ctx.restaurantId, job.locationId, job.type);
    const policy = activeWorkstation ? null : await stationPolicy(tx, ctx.restaurantId, job.locationId, job.type);
    if (policy && !policy.isEnabled) throw new Error("Štampač je isključen");
    const changed = await tx.printJob.updateMany({
      where: { id: job.id, status: "PRINTING", attemptId, claimedBy: ctx.employeeId, submissionStartedAt: null,
        claimedAt: { gte: new Date(Date.now() - STALE_PRINT_LEASE_MS) },
        ...(policy && !policy.autoPrint ? { isAutomatic: false } : {}) },
      data: { submissionStartedAt: new Date() },
    });
    if (!changed.count) throw new Error("Submission not authorized: expired, started, disabled or stale attempt");
    await recordAuditEntry(ctx, { entityType: "PrintJob", entityId: job.id, action: "print.submission_started",
      newValue: { attemptId }, locationId: job.locationId }, tx);
    return tx.printJob.findUniqueOrThrow({ where: { id: job.id } });
  }, { timeout: 15000 });
}

// Only an unstarted claim can expire back to PENDING. Started claims require reconciliation.
// Exported (Faza 2B) so agent-print-service.ts's own stale-recovery sweep —
// needed because the agent may be the ONLY consumer of a station when no
// KDS tab is open — uses the EXACT same threshold, never a duplicated
// magic number that could drift.
export const STALE_PRINT_LEASE_MS = 90_000;

/**
 * KDS polling audit (final performance pass) — ovo je sada ČIST READ put,
 * pozvan svaka ~4s po otvorenom KDS tabu. Ranije je ovo bila TRANSAKCIJA sa
 * lockPrintLocation (SELECT ... FOR UPDATE na CEO location red, ne po
 * stanici), uslovnim suppressAutomaticJobs pozivom, i DVA bezuslovna
 * updateMany "stale recovery" prolaza — 6-7 sekvencijalnih round-trip-ova
 * pod bravom, na SVAKI poll, sa SVAKOG otvorenog taba (Kuhinja+Šank
 * tabovi brave ISTI location red, pa se serijalizuju jedni iza drugih).
 *
 * Dva nalaza uklanjaju tu težinu bez gubitka ijedne garancije:
 *
 * 1) suppressAutomaticJobs OVDE je bio suvišan: settings-service.ts's
 *    upsertPrinterConfig (stvaran "Sačuvaj" na legacy Kuhinja/Šank
 *    formi) VEĆ poziva suppressAutomaticJobs U TRENUTKU kad se
 *    autoPrint/isEnabled isključi — to je JEDINI trenutak kad supresija
 *    ima smisla (dispatchStationPrintJobs sam odbija da napravi NOVI
 *    automatski posao dok je isključeno, pa nijedan "svež" red nikad ne
 *    postoji da bi ga ponovni KDS poll morao da otkrije i suzbije).
 *    Ponovno pozivanje na svaki poll nikad nije radilo ništa što
 *    upsertPrinterConfig već nije uradio ODMAH kad se desilo.
 *
 * 2) Oba "stale recovery" updateMany prolaza su VEĆ duplirana:
 *    agentPrinting.pollAndClaim (Agent-ova SOPSTVENA poll petlja, 1-3s
 *    kad je agent aktivan — brže od ovog 4s KDS poll-a) radi IDENTIČNA
 *    dva updateMany, BEZ ikakve brave — dokaz da brava nikad nije bila
 *    stvarno potrebna za bezbednost ovih redova (updateMany-jevi su već
 *    sami po sebi uslovni/atomski, a diraju status='PRINTING' redove dok
 *    beginPrintAttempt dira SAMO status='PENDING' — disjunktni skupovi,
 *    bez trke). Za stanicu SA aktivnim agentom, KDS poll ne mora ponovo
 *    da radi ovaj posao AT SVE. Za stanicu BEZ agenta (jedini scenario
 *    gde bi zaglavljen ručni pokušaj inače ostao NIKAD oporavljen), isti
 *    par updateMany-jeva se i dalje izvršava ovde, samo BEZ brave — isti
 *    obrazac koji pollAndClaim već bezbedno koristi.
 */
export async function listPendingStationPrintJobs(ctx: AuthContext, locationId: string, station: "KITCHEN" | "BAR") {
  requirePermission(ctx, PRODUCTION_MANAGE);
  requireLocationAccess(ctx, locationId);
  assertStationAccess(ctx, station);

  const activeWorkstation = await activeWorkstationFor(prisma, ctx.restaurantId, locationId, station);
  if (!activeWorkstation) {
    // Isti par sweep-ova, isti oblik, kao agentPrinting.pollAndClaim —
    // NAMERNO bez transakcije/brave (dokazano bezbedno tamo). Samo za
    // stanice BEZ aktivnog agenta: to je JEDINI slučaj gde niko drugi
    // (ni jedan agent poll) već radi ovaj oporavak.
    const scope = { ...scopeToRestaurant(ctx), locationId, station, status: "PRINTING" as const };
    await prisma.printJob.updateMany({
      where: { ...scope, attemptId: { not: null }, submissionStartedAt: null,
        claimedAt: { lt: new Date(Date.now() - STALE_PRINT_LEASE_MS) } },
      data: { status: "PENDING", attemptId: null, claimedBy: null, claimedAt: null },
    });
    await prisma.printJob.updateMany({
      where: { ...scope, submissionStartedAt: { lt: new Date(Date.now() - STALE_PRINT_LEASE_MS) } },
      data: { status: "SUBMISSION_UNKNOWN", failureReason: "Potvrda štampe nedostaje; proverite štampač pre novog otiska." },
    });
  }

  const [policy, jobs] = await Promise.all([
    stationPolicy(prisma, ctx.restaurantId, locationId, station),
    prisma.printJob.findMany({
      where: { ...scopeToRestaurant(ctx), locationId, station, status: { in: ["PENDING", "FAILED", "SUBMISSION_UNKNOWN"] } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return { jobs, autoPrintEligible: policy.isEnabled && policy.autoPrint };
}

/**
 * PREPROD physical QA follow-up — "Poslednja štampa nije uspela" bio je
 * ranije izveden (u kitchen/bar print-jobs rutama) iz `result.jobs.some(...)`
 * iznad — ISTE neograničene liste (bez starosne granice, bez provere da li
 * je porudžbina i dalje relevantna). Jednom neuspeo PrintJob je ostajao
 * FAILED zauvek (ovaj red se nikad ne menja osim eksplicitnim "Pokušaj
 * ponovo"), pa je crveno upozorenje moglo da traje danima posle stvarnog
 * oporavka štampača/agenta, čak i sa nula aktivnih porudžbina — potpuno
 * suprotno onome što bedž treba da predstavlja (TRENUTNO operativno
 * zdravlje, ne doživotna istorija štampe). Nijedan PrintJob red se ovde ne
 * briše/prepisuje — Admin/audit istorija ostaje netaknuta, ovo menja SAMO
 * šta ulazi u KDS upozorenje.
 *
 * Novo pravilo: bedž prati ISHOD POSLEDNJEG završenog (PRINTED/FAILED/
 * SUBMISSION_UNKNOWN) pokušaja štampe ZA OVU STANICU, ali SAMO unutar
 * TEKUĆE OTVORENE SMENE (isti obrazac kao listCompletedStationOrders —
 * "Gotove" je već svesno smenski-obuhvaćena). Kasniji uspeh UVEK poništava
 * raniji neuspeh (ista smena); nova smena UVEK počinje čisto (nijedan
 * neuspeh iz prethodne smene se ne prenosi) — bez proizvoljnog vremenskog
 * praga, koristeći VEĆ postojeći Shift domenski koncept.
 */
export async function hasRecentPrintFailure(ctx: AuthContext, locationId: string, station: "KITCHEN" | "BAR"): Promise<boolean> {
  requirePermission(ctx, PRODUCTION_MANAGE);
  requireLocationAccess(ctx, locationId);
  assertStationAccess(ctx, station);

  const activeShift = await prisma.shift.findFirst({
    where: { ...scopeToRestaurant(ctx), locationId, status: "OPEN" },
    select: { id: true },
  });
  if (!activeShift) return false;

  const latestTerminal = await prisma.printJob.findFirst({
    where: {
      ...scopeToRestaurant(ctx), locationId, station,
      status: { in: ["PRINTED", "FAILED", "SUBMISSION_UNKNOWN"] },
      order: { shiftId: activeShift.id },
    },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  return latestTerminal !== null && latestTerminal.status !== "PRINTED";
}

/** Explicit station print/reprint. Auto-order policy is intentionally not consulted. */
export async function requestStationPrint(ctx: AuthContext, orderId: string, station: Station, idempotencyKey: string, originalJobId?: string) {
  requirePrintAccess(ctx);
  assertStationAccess(ctx, station);
  if (!/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new Error("Invalid print request key");
  const order = await loadOwnedOrder(ctx, orderId);
  return prisma.$transaction(async (tx) => {
    await lockPrintLocation(tx, ctx.restaurantId, order.locationId);
    const policy = await stationPolicy(tx, ctx.restaurantId, order.locationId, station);
    if (!policy.isEnabled) throw new Error("Štampač je isključen");
    const dispatchKey = `manual:${station}:${idempotencyKey}`;
    const existing = await tx.printJob.findUnique({ where: { orderId_dispatchKey: { orderId, dispatchKey } } });
    if (existing) {
      if (existing.reprintOfId !== (originalJobId ?? null) || existing.requestedBy !== ctx.employeeId) throw new Error("Print request key conflict");
      return existing;
    }
    const original = originalJobId ? await tx.printJob.findFirst({ where: {
      id: originalJobId, orderId, station, ...scopeToRestaurant(ctx),
    } }) : null;
    if (originalJobId && !original) throw new Error("Print job nije pronađen");
    let content: Prisma.InputJsonValue;
    if (original) content = original.content as Prisma.InputJsonValue;
    else {
      const rows = await tx.orderItemStation.findMany({ where: { station, status: { not: "CANCELLED" }, orderItem: { orderId } },
        include: { orderItem: { include: { modifiers: { orderBy: { sortOrder: "asc" } } } } } });
      if (!rows.length) throw new Error("Nema poslatih stavki za štampu");
      const table = await tx.restaurantTable.findUniqueOrThrow({ where: { id: order.tableId } });
      const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } });
      const waiter = await tx.employee.findUnique({ where: { id: order.openedBy }, select: { firstName: true, lastName: true } });
      content = toJson(buildKitchenBarTicketContent({ station, restaurantName: restaurant.name, tableLabel: table.label,
        waiterName: waiter ? `${waiter.firstName} ${waiter.lastName}` : "?", orderNumber: shortOrderNumber(order.id), submittedAt: (order.submittedAt ?? new Date()).toISOString(),
        paperWidthMm: policy.paperWidthMm, items: rows.map(({ orderItem: i }) => ({
          quantity: i.quantity, name: i.name, note: i.note, modifiers: formatModifiersForTicket(i.modifiers),
        })) }));
    }
    const job = await tx.printJob.create({ data: { restaurantId: ctx.restaurantId, locationId: order.locationId, orderId,
      type: station, station, dispatchKey, content, isAutomatic: false, isReprint: !!original, reprintOfId: original?.id,
      requestedBy: ctx.employeeId } });
    await recordAuditEntry(ctx, { entityType: "PrintJob", entityId: job.id, action: original ? "print.reprinted" : "print.manual_requested",
      newValue: { orderId, originalJobId: original?.id, station }, locationId: order.locationId }, tx);
    return job;
  });
}

/**
 * Primarna "Štampaj račun" akcija na konobarskom /bill ekranu — Print Agent
 * fizička QA ispravka (Chrome Print Preview root cause). Konobar/telefon
 * NIKAD sam fizički ne štampa (window.print()/BrowserPrintTransport); ova
 * funkcija samo garantuje da autoritativan RECEIPT PrintJob postoji, tačno
 * onaj koji Windows Print Agent (agentPrinting.pollAndClaim, potpuno
 * nezavisna petlja na drugom računaru) preuzima i fizički štampa na
 * WorkstationPrintRoute RECEIPT-a — bez ijednog browser print dijaloga.
 *
 * NAMERNO isti `dispatchKey = receipt:${paymentId}` kao automatski dispatch
 * pri naplati (billing-service.ts/split-bill-service.ts) — isti @@unique
 * upsert red, NIKAD nova fizička kopija. Ovo pokriva TRI slučaja jednim
 * kodom: (1) automatski dispatch pri naplati je već uspeo — ovaj poziv je
 * bezopasan no-op koji vraća POSTOJEĆI red; (2) automatski dispatch je pao
 * (try/catch u billing-service.ts namerno nikad ne obara samo plaćanje) —
 * ovo je PRVA prilika da red uopšte nastane; (3) dupli klik/mrežni retry na
 * OVO dugme — isti ključ, isti red, nikad drugi fizički otisak. `isReprint:
 * false` — ovo NIJE reprint (nema receipt.reprinted audit zapis); svesna,
 * eksplicitna reštampa i dalje ide isključivo kroz reprintReceipt ispod.
 */
export async function printReceipt(ctx: AuthContext, orderId: string) {
  requirePermission(ctx, ORDERS_PRINT);
  await loadOwnedOrder(ctx, orderId);

  const receipt = await prisma.receipt.findFirst({
    where: { orderId, ...scopeToRestaurant(ctx) },
    orderBy: [{ issuedAt: "desc" }, { sequenceNumber: "desc" }],
  });
  if (!receipt) throw new Error("Račun nije pronađen — porudžbina još nije naplaćena");

  const dispatchKey = `receipt:${receipt.paymentId}`;
  await dispatchReceiptPrintJob(ctx, receipt.paymentId, { isReprint: false, dispatchKey, requestedBy: ctx.employeeId });

  return prisma.printJob.findFirstOrThrow({ where: { orderId, dispatchKey } });
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

// ─────────────────────────────────────────────────────────────────────────
// PRINTING P0 — operator reconciliation surface for SUBMISSION_UNKNOWN
// ─────────────────────────────────────────────────────────────────────────

import { acknowledgePrintAmbiguitySchema, type AcknowledgePrintAmbiguityInput } from "@rcs/shared";

/**
 * PRINTING P0 — list PrintJobs currently in SUBMISSION_UNKNOWN that need
 * an operator decision. Drives the Admin WorkstationsPanel banner. Scoped
 * to the current shift window (default: 12 hours) — older rows are still
 * queryable via the audit log but are not surfaced as "needs decision"
 * because the operator would be drowning in ancient history.
 *
 * The list is intentionally compact (id, type, orderId, createdAt,
 * failureReason) — enough for the banner to render "Porudžbina #1234 —
 * Kuhinja — čeka potvrdu od 17:42" with one button each. Full job
 * details (content, attempts, audit trail) are available in the dedicated
 * printJob detail page; we do NOT couple them here to keep the polling
 * cost negligible on the Admin's regular 5s poll loop.
 */
export async function listSubmissionUnknownJobs(ctx: AuthContext) {
  requirePermission(ctx, ORDERS_PRINT);
  const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const rows = await prisma.printJob.findMany({
    where: {
      ...scopeToRestaurant(ctx),
      status: "SUBMISSION_UNKNOWN",
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      type: true,
      orderId: true,
      createdAt: true,
      failureReason: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    orderId: r.orderId,
    createdAt: r.createdAt.toISOString(),
    failureReason: r.failureReason,
  }));
}

/**
 * PRINTING P0 — the ONE operator-only exit from SUBMISSION_UNKNOWN. The
 * Agent poll claim query (agent-print-service.pollAndClaim) is hard-coded
 * to filter `status = "PENDING"` — a SUBMISSION_UNKNOWN job is therefore
 * structurally un-reclaimable by any future Agent poll, regardless of
 * Service restart / network reconnect / Admin reconfiguration. This
 * function is the ONLY way to move such a job out of that terminal
 * state, and it is idempotent: calling it twice with the same decision
 * AND the same idempotencyKey on the same job returns the existing
 * record (no second audit entry, no second timestamp bump, no second
 * physical reprint PrintJob).
 *
 * Two valid decisions:
 *
 *   "PRINTED" — operator confirmed at the printer that the ticket did
 *               physically come out (or is willing to accept that they
 *               cannot rule it out). Job becomes PRINTED with
 *               printedAt = now and `operatorConfirmedPrintedAt` set;
 *               failureReason cleared. Server-side `status` is now
 *               terminal — no further poll claim, no further
 *               reconciliation possible from any caller.
 *
 *   "REPRINT" — operator wants another physical copy. Job stays
 *               SUBMISSION_UNKNOWN (the ambiguity is preserved as the
 *               authoritative record of what happened on the original
 *               attempt), and a NEW PrintJob is created with
 *               `isReprint = true` and `reprintOfId = this.id`, reusing
 *               the existing reprint pipeline so audit + receipt
 *               semantics are identical to a manual reprint. The
 *               child PrintJob's dispatchKey is DETERMINISTICALLY
 *               derived from `(parentJobId, idempotencyKey)` so a
 *               double-click with the SAME idempotencyKey hits the
 *               @@unique([orderId, dispatchKey]) constraint and
 *               returns the existing child without creating a second
 *               one. INTENTIONAL later reprints are still possible by
 *               generating a fresh idempotencyKey — the Admin UI does
 *               this automatically when the user clicks the button
 *               again after the request completes.
 *
 * Idempotency:
 *   The CALLER supplies an idempotencyKey (UUID) generated at the moment
 *   of click. It is NOT derived server-side. This is the standard
 *   pattern (Stripe, PayPal, etc.) — a slow network, stuck modal, or
 *   browser retry can all re-fire the SAME user intent, and the
 *   idempotencyKey is what makes "the same intent" recognizable. The
 *   UI keeps the idempotencyKey in a ref (not a fresh UUID per click)
 *   for the entire duration of the request and ignores subsequent
 *   clicks until the request resolves.
 *
 * Anything else (job not found, job in a different status, employee
 * without the right permission) throws — no silent success.
 */
export async function acknowledgePrintAmbiguity(
  ctx: AuthContext,
  printJobId: string,
  rawInput: AcknowledgePrintAmbiguityInput
) {
  requirePermission(ctx, ORDERS_PRINT);
  const input = acknowledgePrintAmbiguitySchema.parse(rawInput);

  const job = await prisma.printJob.findFirst({
    where: { id: printJobId, ...scopeToRestaurant(ctx) },
    select: {
      id: true,
      orderId: true,
      restaurantId: true,
      locationId: true,
      type: true,
      station: true,
      status: true,
      dispatchKey: true,
      attemptId: true,
      content: true,
      isReprint: true,
      reprintOfId: true,
      operatorConfirmedPrintedAt: true,
      operatorReprintRequestedAt: true,
      requestedBy: true,
    },
  });
  if (!job) throw new Error("PrintJob nije pronađen");

  // PRINTING P0 — idempotency check FIRST, status check SECOND.
  // operatorConfirmedPrintedAt is the truth source: once set, this PrintJob
  // is terminal — every subsequent call (with ANY idempotencyKey, intentional
  // or accidental) returns the same record without re-writing the audit log
  // or throwing. The status-throw below is reserved for genuine "wrong
  // operator action" cases (job moved on without ever being acknowledged).
  if (input.decision === "PRINTED") {
    if (job.operatorConfirmedPrintedAt) {
      return { id: job.id, status: "PRINTED", printedAt: job.operatorConfirmedPrintedAt, idempotentReplay: true };
    }
  }
  if (job.status !== "SUBMISSION_UNKNOWN") {
    throw new Error(`PrintJob nije u SUBMISSION_UNKNOWN stanju (trenutno: ${job.status})`);
  }

  if (input.decision === "PRINTED") {
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const j = await tx.printJob.update({
        where: { id: job.id },
        data: {
          status: "PRINTED",
          printedAt: now,
          operatorConfirmedPrintedAt: now,
          operatorConfirmedPrintedBy: ctx.employeeId,
          failureReason: null,
          resultOutcome: "SUBMITTED_TO_SPOOLER",
        },
        select: { id: true, status: true, printedAt: true },
      });
      await recordAuditEntry(ctx, {
        entityType: "PrintJob",
        entityId: job.id,
        action: "printjob.ambiguity_confirmed_printed",
        previousValue: { status: "SUBMISSION_UNKNOWN" },
        newValue: { status: "PRINTED", at: now.toISOString(), operatorId: ctx.employeeId, idempotencyKey: input.idempotencyKey },
        locationId: job.locationId,
      });
      return j;
    });
    return updated;
  }

  // decision === "REPRINT"
  // REPRINT idempotency: derive the child PrintJob's dispatchKey
  // DETERMINISTICALLY from (parentJobId, idempotencyKey). The
  // @@unique([orderId, dispatchKey]) constraint guarantees that the
  // second click with the SAME idempotencyKey either:
  //   (a) returns the existing child via findUnique, or
  //   (b) trips a unique-violation on insert which we catch and
  //       recover from by re-reading the existing row.
  // A fresh idempotencyKey (Admin re-clicks after the request resolves)
  // produces a fresh dispatchKey and a fresh child PrintJob — this is
  // the legitimate "operator wants ANOTHER copy" path.
  const childDispatchKey = `reprint-ambiguity:${job.id}:${input.idempotencyKey}`;
  const existingChild = await prisma.printJob.findUnique({
    where: { orderId_dispatchKey: { orderId: job.orderId, dispatchKey: childDispatchKey } },
    select: { id: true, dispatchKey: true, status: true, reprintOfId: true, createdAt: true },
  });
  if (existingChild) {
    return { ...existingChild, idempotentReplay: true };
  }
  const now = new Date();
  try {
    const newJob = await prisma.$transaction(async (tx) => {
      const created = await tx.printJob.create({
        data: {
          restaurantId: job.restaurantId,
          locationId: job.locationId,
          orderId: job.orderId,
          type: job.type,
          station: job.station,
          content: job.content as object,
          dispatchKey: childDispatchKey,
          status: "PENDING",
          isAutomatic: true,
          isReprint: true,
          reprintOfId: job.id,
          requestedBy: ctx.employeeId,
          resultOutcome: null,
        },
        select: { id: true, dispatchKey: true, status: true, reprintOfId: true, createdAt: true },
      });
      await tx.printJob.update({
        where: { id: job.id },
        data: {
          operatorReprintRequestedAt: now,
          operatorReprintRequestedBy: ctx.employeeId,
        },
      });
      await recordAuditEntry(ctx, {
        entityType: "PrintJob",
        entityId: job.id,
        action: "printjob.ambiguity_reprint_requested",
        previousValue: { operatorReprintRequestedAt: null },
        newValue: {
          at: now.toISOString(),
          operatorId: ctx.employeeId,
          idempotencyKey: input.idempotencyKey,
          newPrintJobId: created.id,
          newDispatchKey: created.dispatchKey,
        },
        locationId: job.locationId,
      });
      return created;
    });
    return newJob;
  } catch (err: any) {
    // Race: a concurrent request with the same idempotencyKey won the
    // insert. Recover by re-reading the existing child.
    if (err?.code === "P2002" || /unique/i.test(String(err?.message ?? ""))) {
      const recovered = await prisma.printJob.findUnique({
        where: { orderId_dispatchKey: { orderId: job.orderId, dispatchKey: childDispatchKey } },
        select: { id: true, dispatchKey: true, status: true, reprintOfId: true, createdAt: true },
      });
      if (recovered) return { ...recovered, idempotentReplay: true };
    }
    throw err;
  }
}

export { stationLabelFor };
