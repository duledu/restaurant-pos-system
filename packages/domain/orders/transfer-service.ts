/**
 * FAZA 8 — TRANSFER STAVKI IZMEĐU STOLOVA.
 *
 * Premešta NEPLAĆENU količinu jedne ili više OrderItem stavki sa jedne
 * (izvorne, već poslate) porudžbine na drugu (odredišnu) porudžbinu —
 * NIKAD prodaja, NIKAD storno, NIKAD nova naplata, NIKAD nova
 * zaliha/normativ dedukcija. Samo neplaćen ostatak (`quantity -
 * paidQuantity`) sme da se prebaci — već naplaćena količina ostaje vezana
 * za izvornu porudžbinu (njen Payment/PaymentItem/Receipt trag mora ostati
 * tačan).
 *
 * DVA REŽIMA PREMEŠTANJA STAVKE:
 *  - CEO red (paidQuantity === 0 i tražena količina === item.quantity):
 *    samo se re-pointuje `orderId` na postojećem OrderItem redu. Ovo je
 *    NAMERNO najsigurniji put — OrderItemStation (KDS istorija),
 *    OrderItemModifier, id, price/taxRate snapshot ostaju POTPUNO
 *    netaknuti (referenciraju se po orderItemId, ne po orderId).
 *  - DELIMIČNO (preostala tražena količina < neplaćen ostatak, ILI stavka
 *    već ima plaćen deo pa mora ostati vezana za izvornu porudžbinu): novi
 *    OrderItem red se kreira na odredišnoj porudžbini sa istim
 *    name/price/taxRate/note/preparationStation/status snapshot-om,
 *    OrderItemModifier redovi se KOPIRAJU, i OrderItemStation redovi se
 *    KOPIRAJU (isti station+status kao izvor) — kuhinja/šank i dalje vide
 *    tačno onoliko preostalih jedinica za pripremu koliko fizički postoji,
 *    sada raspoređeno na dva tiketa/porudžbine, bez ijednog NOVOG zahteva
 *    za pripremu (nema CREATE sa statusom SUBMITTED za već-u-toku stavku).
 *
 * ODREDIŠNA PORUDŽBINA: ako sto već ima aktivnu porudžbinu koja NIJE DRAFT,
 * stavke se dodaju na nju. Ako sto nema aktivnu porudžbinu, NOVA porudžbina
 * se kreira DIREKTNO u statusu SUBMITTED (bez DRAFT faze) — stavka koja se
 * premešta je već poslata kuhinji/šanku, mešanje DRAFT statusa porudžbine
 * sa već-poslatim stavkama bi prekršilo postojeću invarijantu "DRAFT =
 * ništa još nije poslato" (order-service.ts). Transfer u sto čija je
 * aktivna porudžbina i dalje DRAFT je ODBIJEN iz istog razloga — konobar
 * na tom stolu prvo mora poslati (ili otvoriti drugi sto).
 *
 * VLASNIŠTVO/RBAC: ista pravila kao ostatak Faze 3+ — requireOrderOperator
 * (WAITER ili menadžment) + requireLocationAccess. Postojeća invarijanta
 * (order-access.ts) je da SUBMITTED+ porudžbina NEMA per-konobar vlasništvo
 * (svaki WAITER sa pristupom lokaciji sme da naplati/poništi/sada i
 * prebaci) — transfer NAMERNO prati ISTO pravilo, ne uvodi strožu granicu.
 * Transfer IZ DRAFT porudžbine nije podržan ovim putem (draft stavke se
 * premeštaju trivijalno kroz postojeći removeItem/addItem, bez potrebe za
 * novom putanjom) — samo već-poslate (SUBMITTED..SERVED) porudžbine.
 *
 * LOKACIJA/TENANT: destinationTable se učitava kroz `scopeToRestaurant`
 * (cross-restaurant transfer je STRUKTURNO nemoguć — upit ne bi našao
 * sto drugog restorana). Cross-location transfer je EKSPLICITNO odbijen
 * (podrazumevano bezbedno pravilo iz specifikacije).
 */
import { prisma, Prisma } from "@rcs/db";
import { requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { ssePublisher } from "../realtime/sse-publisher";
import { getActiveShift } from "../shifts/shift-service";
import { requireOrderOperator } from "./order-access";
import type { TransferOrderItemsInput } from "@rcs/shared";

const TRANSFERABLE_ORDER_STATUSES = new Set(["SUBMITTED", "ACCEPTED", "PREPARING", "READY", "SERVED"]);

type SourceOrder = Prisma.OrderGetPayload<{
  include: { items: { include: { modifiers: true } }; table: { include: { floor: true } } };
}>;

export async function transferOrderItems(ctx: AuthContext, sourceOrderId: string, input: TransferOrderItemsInput) {
  requireOrderOperator(ctx);

  const sourceOrder: SourceOrder | null = await prisma.order.findFirst({
    where: { id: sourceOrderId, ...scopeToRestaurant(ctx) },
    include: {
      items: { include: { modifiers: { orderBy: { sortOrder: "asc" } } }, orderBy: { createdAt: "asc" } },
      table: { include: { floor: true } },
    },
  });
  if (!sourceOrder) throw new Error("Izvorna porudžbina nije pronađena");
  requireLocationAccess(ctx, sourceOrder.locationId);

  if (sourceOrder.status === "DRAFT") {
    throw new Error("Nacrt porudžbine se ne prebacuje ovim putem — ukloni stavku i dodaj je direktno na drugi sto");
  }
  if (sourceOrder.status === "COMPLETED" || sourceOrder.status === "CANCELLED") {
    throw new Error("Porudžbina je zatvorena — transfer stavki nije moguć");
  }
  if (!TRANSFERABLE_ORDER_STATUSES.has(sourceOrder.status)) {
    throw new Error("Porudžbina nije u stanju koje dozvoljava transfer stavki");
  }

  const destinationTable = await prisma.restaurantTable.findFirst({
    where: { id: input.destinationTableId, floor: scopeToRestaurant(ctx) },
    include: { floor: true },
  });
  if (!destinationTable) throw new Error("Odredišni sto nije pronađen");
  if (!destinationTable.isActive) throw new Error("Odredišni sto nije aktivan");
  if (destinationTable.id === sourceOrder.tableId) throw new Error("Odredišni sto je isti kao izvorni sto");
  requireLocationAccess(ctx, destinationTable.floor.locationId);
  if (destinationTable.floor.locationId !== sourceOrder.locationId) {
    // Podrazumevano bezbedno pravilo iz specifikacije: transfer je dozvoljen
    // samo unutar iste lokacije (cross-restaurant je već strukturno
    // nemoguć preko scopeToRestaurant upita iznad).
    throw new Error("Transfer stavki je dozvoljen samo unutar iste lokacije");
  }

  const requestedByItem = new Map<string, number>();
  for (const line of input.lines) {
    if (requestedByItem.has(line.orderItemId)) throw new Error("Dupliran red u zahtevu za istu stavku");
    requestedByItem.set(line.orderItemId, line.quantity);
  }
  if (requestedByItem.size === 0) throw new Error("Nema izabranih stavki za transfer");

  const itemById = new Map(sourceOrder.items.map((i) => [i.id, i]));
  for (const [itemId, quantity] of requestedByItem) {
    const item = itemById.get(itemId);
    if (!item) throw new Error("Stavka ne pripada izvornoj porudžbini");
    if (item.status === "CANCELLED") throw new Error(`Stavka "${item.name}" je poništena i ne može se prebaciti`);
    const available = item.quantity - item.paidQuantity;
    if (quantity > available) {
      throw new Error(`Tražena količina za "${item.name}" (${quantity}) je veća od neplaćenog ostatka (${available})`);
    }
  }

  // Aktivna smena se učitava PRE transakcije (ista konvencija kao
  // billing-service.completePayment) — koristi se SAMO ako odredišni sto
  // nema postojeću aktivnu porudžbinu.
  const existingDestinationOrder = await prisma.order.findFirst({
    where: { tableId: destinationTable.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
  });
  if (existingDestinationOrder && existingDestinationOrder.status === "DRAFT") {
    throw new Error("Odredišni sto ima nepočetu (nacrt) porudžbinu — prvo je pošalji ili izaberi drugi sto");
  }
  let destinationShiftId: string | null = null;
  if (!existingDestinationOrder) {
    const shift = await getActiveShift(ctx, sourceOrder.locationId);
    if (!shift) throw new Error("Nema aktivne smene na ovoj lokaciji — transfer nije moguć");
    destinationShiftId = shift.id;
  }

  const actorRole = ctx.roles[0] ?? "UNKNOWN";

  const result = await prisma.$transaction(async (tx) => {
    let destinationOrderId: string;
    if (existingDestinationOrder) {
      destinationOrderId = existingDestinationOrder.id;
    } else {
      const created = await tx.order.create({
        data: {
          restaurantId: ctx.restaurantId,
          locationId: sourceOrder.locationId,
          tableId: destinationTable.id,
          shiftId: destinationShiftId!,
          openedBy: ctx.employeeId,
          status: "SUBMITTED",
          submittedAt: new Date(),
        },
      });
      destinationOrderId = created.id;
      await tx.restaurantTable.update({ where: { id: destinationTable.id }, data: { status: "OCCUPIED" } });
      await tx.orderEvent.create({
        data: { orderId: destinationOrderId, type: "order_opened_via_transfer", createdBy: ctx.employeeId },
      });
    }

    const transfers: Array<{ id: string; itemName: string; quantity: number }> = [];

    for (const [itemId, quantity] of requestedByItem) {
      const item = itemById.get(itemId)!;
      const available = item.quantity - item.paidQuantity;
      let destinationItemId: string;

      if (item.paidQuantity === 0 && quantity === item.quantity) {
        // Ceo red, ništa plaćeno — bezbedno re-pointovati orderId direktno,
        // KDS istorija/modifikatori/id ostaju netaknuti.
        const guard = await tx.orderItem.updateMany({
          where: { id: item.id, orderId: sourceOrderId, quantity: item.quantity, paidQuantity: 0, status: { not: "CANCELLED" } },
          data: { orderId: destinationOrderId },
        });
        if (guard.count !== 1) {
          throw new Error(`Stavka "${item.name}" je izmenjena u međuvremenu — osveži prikaz i pokušaj ponovo`);
        }
        destinationItemId = item.id;
      } else {
        if (quantity > available) {
          throw new Error(`Tražena količina za "${item.name}" (${quantity}) je veća od neplaćenog ostatka (${available})`);
        }
        // Delimično: umanji izvorni red, kreiraj novi na odredištu.
        const guard = await tx.orderItem.updateMany({
          where: { id: item.id, quantity: item.quantity, paidQuantity: item.paidQuantity, status: { not: "CANCELLED" } },
          data: { quantity: item.quantity - quantity },
        });
        if (guard.count !== 1) {
          throw new Error(`Stavka "${item.name}" je izmenjena u međuvremenu — osveži prikaz i pokušaj ponovo`);
        }

        const newItem = await tx.orderItem.create({
          data: {
            orderId: destinationOrderId,
            menuItemId: item.menuItemId,
            name: item.name,
            price: item.price,
            taxRate: item.taxRate,
            quantity,
            note: item.note,
            preparationStation: item.preparationStation,
            status: item.status,
          },
        });
        destinationItemId = newItem.id;

        if (item.modifiers.length > 0) {
          await tx.orderItemModifier.createMany({
            data: item.modifiers.map((m) => ({
              orderItemId: newItem.id,
              modifierOptionId: m.modifierOptionId,
              groupName: m.groupName,
              optionName: m.optionName,
              priceDelta: m.priceDelta,
              sortOrder: m.sortOrder,
            })),
          });
        }

        const stationStates = await tx.orderItemStation.findMany({ where: { orderItemId: item.id } });
        if (stationStates.length > 0) {
          await tx.orderItemStation.createMany({
            data: stationStates.map((s) => ({ orderItemId: newItem.id, station: s.station, status: s.status })),
          });
        }
      }

      const transferRecord = await tx.orderItemTransfer.create({
        data: {
          restaurantId: ctx.restaurantId,
          locationId: sourceOrder.locationId,
          sourceOrderId,
          sourceOrderItemId: item.id,
          destinationOrderId,
          destinationOrderItemId: destinationItemId,
          sourceTableLabel: sourceOrder.table.label,
          destinationTableLabel: destinationTable.label,
          itemName: item.name,
          quantity,
          transferredBy: ctx.employeeId,
          transferredByRole: actorRole,
        },
      });
      transfers.push({ id: transferRecord.id, itemName: item.name, quantity });

      await tx.orderEvent.create({
        data: {
          orderId: sourceOrderId,
          type: "item_transferred_out",
          createdBy: ctx.employeeId,
          payload: { itemId: item.id, quantity, destinationOrderId, destinationTableLabel: destinationTable.label },
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId: destinationOrderId,
          type: "item_transferred_in",
          createdBy: ctx.employeeId,
          payload: { itemId: destinationItemId, quantity, sourceOrderId, sourceTableLabel: sourceOrder.table.label },
        },
      });

      await recordAuditEntry(
        ctx,
        {
          entityType: "OrderItem",
          entityId: item.id,
          action: "order_item.transferred",
          previousValue: { orderId: sourceOrderId, tableLabel: sourceOrder.table.label },
          newValue: { orderId: destinationOrderId, tableLabel: destinationTable.label, quantity },
          locationId: sourceOrder.locationId,
          category: "ADMIN_ACTION",
        },
        tx
      );
    }

    // Auto-čišćenje: ako izvornoj porudžbini posle transfera nije ostala
    // nijedna živa (nepotpuno-poništena) stavka, sto ne sme ostati zauvek
    // "zauzet" sa porudžbinom koja se više nikad ne može naplatiti (nema
    // stavki za billing.getBillPreview). Ako porudžbina VEĆ ima Payment
    // (delimično plaćena pre nego što je sav ostatak prebačen) — u
    // potpunosti je settled, zatvara se kao COMPLETED. Ako NEMA
    // nijedan Payment — nema šta da se naplati niti ikad je bilo, zatvara
    // se kao CANCELLED (isti duh kao cancelAbandonedOrder), NIKAD ne
    // kreira Payment/Receipt.
    const remainingSourceItems = await tx.orderItem.findMany({
      where: { orderId: sourceOrderId, status: { not: "CANCELLED" }, quantity: { gt: 0 } },
      select: { id: true },
    });
    let sourceClosedAs: "COMPLETED" | "CANCELLED" | null = null;
    if (remainingSourceItems.length === 0) {
      const hasPayments = (await tx.payment.count({ where: { orderId: sourceOrderId } })) > 0;
      const nextStatus = hasPayments ? "COMPLETED" : "CANCELLED";
      const guard = await tx.order.updateMany({
        where: { id: sourceOrderId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: nextStatus },
      });
      if (guard.count === 1) {
        sourceClosedAs = nextStatus;
        await tx.restaurantTable.updateMany({ where: { id: sourceOrder.tableId }, data: { status: "FREE" } });
        await tx.orderEvent.create({
          data: {
            orderId: sourceOrderId,
            type: nextStatus === "COMPLETED" ? "order_fully_settled" : "order_cancelled",
            createdBy: ctx.employeeId,
            payload: { reason: "Sve stavke prebačene na drugi sto" },
          },
        });
      }
    }

    return { destinationOrderId, transfers, sourceClosedAs };
  });

  await ssePublisher.publish({
    type: "order_item.status_changed",
    restaurantId: ctx.restaurantId,
    locationId: sourceOrder.locationId,
    payload: { orderId: sourceOrderId, destinationOrderId: result.destinationOrderId },
    occurredAt: new Date().toISOString(),
  });

  return result;
}
