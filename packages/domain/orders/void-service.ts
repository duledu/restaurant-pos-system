import { prisma, Prisma } from "@rcs/db";
import { requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { ssePublisher } from "../realtime/sse-publisher";
import { dispatchCancellationPrintJob } from "../printing/print-service";
import { requireOrderOperator, isOrderManager, requireVoidAuthority } from "./order-access";
import { isMeaningfulVoidExplanation } from "@rcs/shared";
import type { VoidOrderItemInput } from "@rcs/shared";

// Isti skup statusa kao billing.PAYABLE_STATUSES — porudžbina mora biti
// POSLATA (ne DRAFT) i JOŠ NENAPLAĆENA (ne COMPLETED/CANCELLED) da bi se
// bilo šta na njoj poništavalo (specifikacija #16 — plaćena porudžbina se
// ne dira).
const VOIDABLE_ORDER_STATUSES = new Set(["SUBMITTED", "ACCEPTED", "PREPARING", "READY", "SERVED"]);
const NON_VOIDABLE_ITEM_STATUSES = new Set(["DRAFT", "CANCELLED"]);

// Prost fiksni prag (RSD) za "void visoke vrednosti" — vidi napomenu uz
// slične konstante u audit-service.ts (namerno bez AI/ML skoringa).
const HIGH_VALUE_VOID_RSD = new Prisma.Decimal(3000);

/**
 * Poništavanje (potpuno ili delimično) VEĆ POSLATE stavke — jedina
 * dozvoljena putanja za smanjenje/otkazivanje stavke posle submitOrder-a
 * (specifikacija #2). Menadžment-only (requireVoidAuthority) — vidi
 * napomenu u order-access.ts.
 *
 * Transakciona celina (specifikacija #18): autentifikacija/permisije/
 * scoping su već provereni pre transakcije; SVEŽA provera stanja porudžbine
 * + atomski guard na trenutnu količinu se rade UNUTAR transakcije da
 * zatvore race sa paralelnim completePayment ili drugim konkurentnim
 * void zahtevom (specifikacija #19).
 */
export async function voidOrderItem(
  ctx: AuthContext,
  orderId: string,
  itemId: string,
  input: VoidOrderItemInput
) {
  requireOrderOperator(ctx);

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...scopeToRestaurant(ctx) },
    include: { table: { select: { label: true } } },
  });
  if (!order) throw new Error("Porudžbina nije pronađena");
  requireLocationAccess(ctx, order.locationId);

  if (!isOrderManager(ctx)) {
    // Konobar (ili bilo ko bez menadžment role) je pokušao void — zabeleži
    // PRE odbijanja (specifikacija #11), zatim odbij sa jasnom porukom.
    await recordAuditEntry(ctx, {
      entityType: "OrderItem",
      entityId: itemId,
      action: "order_item.void_attempt_rejected",
      newValue: { orderId, requestedQuantity: input.quantity },
      locationId: order.locationId,
      category: "UNAUTHORIZED_ATTEMPT",
      severity: "WARNING",
      isSuspicious: true,
    });
    requireVoidAuthority(ctx); // uvek baca ForbiddenError na ovoj grani
  }

  if (order.status === "COMPLETED" || order.status === "CANCELLED") {
    throw new Error("Porudžbina je već zatvorena — plaćena/otkazana porudžbina se ne može menjati");
  }
  if (!VOIDABLE_ORDER_STATUSES.has(order.status)) {
    throw new Error("Porudžbina još nije poslata — nema šta da se poništi");
  }

  if (!isMeaningfulVoidExplanation(input.explanation)) {
    throw new Error("Obrazloženje mora biti smisleno i dovoljno opisno (ne samo „.“, „test“ i sl.)");
  }

  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new Error("Stavka nije pronađena");
  if (NON_VOIDABLE_ITEM_STATUSES.has(item.status)) {
    throw new Error(item.status === "CANCELLED" ? "Stavka je već poništena" : "Stavka još nije poslata");
  }
  if (input.quantity > item.quantity) {
    throw new Error(`Tražena količina (${input.quantity}) je veća od preostale količine (${item.quantity})`);
  }

  const quantityBefore = item.quantity;
  const quantityAfter = quantityBefore - input.quantity;
  const unitPrice = new Prisma.Decimal(item.price);
  const voidedValue = unitPrice.mul(input.quantity).toDecimalPlaces(2);
  const isFullVoid = quantityAfter === 0;
  const isHighValue = voidedValue.greaterThanOrEqualTo(HIGH_VALUE_VOID_RSD);

  const voidRecord = await prisma.$transaction(async (tx) => {
    // Sveža provera stanja porudžbine UNUTAR transakcije — zatvara
    // vremenski prozor (TOCTOU) između gornje provere i ovog trenutka u
    // kom bi paralelan completePayment mogao da zaključa porudžbinu.
    const freshOrder = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    if (freshOrder.status === "COMPLETED" || freshOrder.status === "CANCELLED") {
      throw new Error("Porudžbina je u međuvremenu zatvorena — poništavanje nije moguće");
    }

    // Atomski guard na TRENUTNU (upravo pročitanu) količinu — isti obrazac
    // kao billing.completePayment/production.advanceItemStatus. Dva
    // konkurentna void zahteva nad istom stavkom: samo jedan pogađa WHERE
    // klauzulu, drugi dobija jasnu grešku umesto nemoguće (negativne) količine.
    const guard = await tx.orderItem.updateMany({
      where: { id: itemId, quantity: quantityBefore },
      data: { quantity: quantityAfter, status: isFullVoid ? "CANCELLED" : item.status },
    });
    if (guard.count !== 1) {
      throw new Error("Stavka je izmenjena u međuvremenu — osveži prikaz i pokušaj ponovo");
    }

    if (isFullVoid) {
      // Kuhinja/šank NE SME tiho nastaviti pripremu stavke koju je konobar
      // (ili menadžer) upravo poništio — postojeća stanica-status arhitektura
      // (Faza 1) već ima CANCELLED status i listStationOrders ga već
      // isključuje iz aktivnog prikaza (specifikacija #20), bez izmena tamo.
      await tx.orderItemStation.updateMany({
        where: { orderItemId: itemId, status: { notIn: ["CANCELLED", "SERVED"] } },
        data: { status: "CANCELLED" },
      });
    }

    const created = await tx.orderItemVoid.create({
      data: {
        restaurantId: ctx.restaurantId,
        locationId: order.locationId,
        orderId,
        orderItemId: itemId,
        shiftId: order.shiftId,
        tableLabel: order.table.label,
        itemName: item.name,
        unitPrice: item.price,
        quantityBefore,
        voidedQuantity: input.quantity,
        quantityAfter,
        voidedValue,
        reasonCode: input.reasonCode,
        explanation: input.explanation.trim(),
        voidedBy: ctx.employeeId,
        voidedByRole: ctx.roles[0] ?? "UNKNOWN",
      },
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        type: "item_voided",
        createdBy: ctx.employeeId,
        payload: {
          itemId,
          quantityBefore,
          voidedQuantity: input.quantity,
          quantityAfter,
          reasonCode: input.reasonCode,
          voidedValue: voidedValue.toString(),
        },
      },
    });

    await recordAuditEntry(
      ctx,
      {
        entityType: "OrderItem",
        entityId: itemId,
        action: isFullVoid ? "order_item.voided_full" : "order_item.voided_partial",
        previousValue: { quantity: quantityBefore, status: item.status },
        newValue: {
          quantity: quantityAfter,
          status: isFullVoid ? "CANCELLED" : item.status,
          reasonCode: input.reasonCode,
          explanation: input.explanation.trim(),
          voidedQuantity: input.quantity,
          voidedValue: voidedValue.toString(),
        },
        reason: input.reasonCode,
        locationId: order.locationId,
        category: "VOID",
        severity: isHighValue ? "HIGH" : "INFO",
        isSuspicious: isHighValue,
      },
      tx
    );

    return created;
  });

  await ssePublisher.publish({
    type: "order_item.voided",
    restaurantId: ctx.restaurantId,
    locationId: order.locationId,
    payload: { orderId, itemId, quantityAfter, isFullVoid },
    occurredAt: new Date().toISOString(),
  });

  // Faza 6: STORNO tiket za stanice koje su stvarno primile stavku, TEK
  // POSLE commit-a — neuspeh štampe nikad ne sme oboriti već izvršeno
  // poništavanje. Nema efekta za delimično poništavanje (isFullVoid=false),
  // vidi napomenu u dispatchCancellationPrintJob.
  try {
    await dispatchCancellationPrintJob(ctx, voidRecord.id);
  } catch (err) {
    console.error("[printing] dispatchCancellationPrintJob failed for void", voidRecord.id, err);
  }

  return voidRecord;
}
