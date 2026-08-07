import { prisma } from "@rcs/db";
import { requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { ssePublisher } from "../realtime/sse-publisher";
import { getActiveShift } from "../shifts/shift-service";
import { getTable } from "../tables/table-service";
import type { OpenOrderInput, AddOrderItemInput, UpdateOrderItemInput, SubmitOrderInput } from "@rcs/shared";

/**
 * Otvara NOVU draft porudžbinu za sto (ili vraća postojeći DRAFT ako već
 * postoji za taj sto — konobar se ne kažnjava dvostrukim klikom na isti
 * sto). Zahteva aktivnu smenu na lokaciji stola (pravilo iz plana: bez
 * smene nema unosa porudžbina).
 */
export async function openOrder(ctx: AuthContext, input: OpenOrderInput) {
  const table = await getTable(ctx, input.tableId);
  const shift = await getActiveShift(ctx, table.floor.locationId);
  if (!shift) {
    throw new Error("Nema aktivne smene na ovoj lokaciji — otvori smenu pre unosa porudžbina");
  }

  const existingDraft = await prisma.order.findFirst({
    where: { ...scopeToRestaurant(ctx), tableId: input.tableId, status: "DRAFT" },
  });
  if (existingDraft) return existingDraft;

  const order = await prisma.order.create({
    data: {
      restaurantId: ctx.restaurantId,
      locationId: table.floor.locationId,
      tableId: input.tableId,
      shiftId: shift.id,
      openedBy: ctx.employeeId,
      guestCount: input.guestCount,
    },
  });

  await prisma.restaurantTable.update({ where: { id: input.tableId }, data: { status: "OCCUPIED" } });

  await prisma.orderEvent.create({
    data: { orderId: order.id, type: "order_opened", createdBy: ctx.employeeId },
  });

  return order;
}

async function getOwnedDraftOrder(ctx: AuthContext, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, ...scopeToRestaurant(ctx) } });
  if (!order) throw new Error("Porudžbina nije pronađena");
  // Restoran može imati više lokacija — restaurantId scoping sam po sebi
  // NIJE dovoljan (zaposleni sa pristupom Lokaciji A ne sme dotaći
  // porudžbinu Lokacije B u istom restoranu).
  requireLocationAccess(ctx, order.locationId);
  if (order.status !== "DRAFT") throw new Error("Porudžbina više nije u nacrtu — ne može se menjati ovim putem");
  return order;
}

export async function getOrder(ctx: AuthContext, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...scopeToRestaurant(ctx) },
    include: { items: { orderBy: { createdAt: "asc" } }, table: true },
  });
  if (!order) throw new Error("Porudžbina nije pronađena");
  requireLocationAccess(ctx, order.locationId);
  return order;
}

export async function addItem(ctx: AuthContext, orderId: string, input: AddOrderItemInput) {
  const order = await getOwnedDraftOrder(ctx, orderId);

  const menuItem = await prisma.menuItem.findFirst({
    where: { id: input.menuItemId, restaurantId: ctx.restaurantId, deletedAt: null },
  });
  if (!menuItem) throw new Error("Artikal nije pronađen");
  if (!menuItem.isActive || !menuItem.isAvailable) {
    throw new Error("Artikal trenutno nije dostupan za prodaju");
  }

  // Snapshot se pravi OVDE, pri dodavanju u draft — ne pri submit-u — jer
  // konobar treba da vidi tačnu cenu u pregledu porudžbine pre slanja.
  // Cena se PONOVO snapshot-uje (ne menja) pri submitOrder ispod, na
  // slučaj da je cena promenjena između dodavanja u draft i slanja.
  const item = await prisma.orderItem.create({
    data: {
      orderId,
      menuItemId: menuItem.id,
      name: menuItem.name,
      price: menuItem.price,
      taxRate: menuItem.taxRate,
      quantity: input.quantity,
      note: input.note,
      preparationStation: menuItem.preparationStation,
    },
  });

  await prisma.orderEvent.create({
    data: {
      orderId,
      type: "item_added",
      createdBy: ctx.employeeId,
      payload: { menuItemId: menuItem.id, name: menuItem.name, quantity: input.quantity },
    },
  });

  return item;
}

export async function updateItem(ctx: AuthContext, orderId: string, itemId: string, input: UpdateOrderItemInput) {
  await getOwnedDraftOrder(ctx, orderId);

  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new Error("Stavka nije pronađena");

  const updated = await prisma.orderItem.update({ where: { id: itemId }, data: input });

  await prisma.orderEvent.create({
    data: { orderId, type: "item_updated", createdBy: ctx.employeeId, payload: input },
  });

  return updated;
}

export async function removeItem(ctx: AuthContext, orderId: string, itemId: string) {
  await getOwnedDraftOrder(ctx, orderId);

  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new Error("Stavka nije pronađena");

  // Stavka je I DALJE u DRAFT-u (nikad poslata kuhinji/šanku) — fizičko
  // brisanje je bezbedno ovde. Nakon submit-a, uklanjanje stavke ide kroz
  // sasvim drugu putanju (item_cancel_requested/approved, Faza 5), NIKAD
  // ovom funkcijom — vidi pravilo "poslata stavka se ne menja in-place".
  await prisma.orderItem.delete({ where: { id: itemId } });

  await prisma.orderEvent.create({
    data: { orderId, type: "item_removed", createdBy: ctx.employeeId, payload: { itemId, name: item.name } },
  });
}

/**
 * Slanje porudžbine — jedina kritična transakcija u Fazi 3. Redosled je
 * namerno: validacija → transakcija → commit → (Faza 4+: pokušaj štampe VAN
 * transakcije, Faza 6) → real-time obaveštenje. Real-time publish je posle
 * uspešnog COMMIT-a, nikad unutar transakcije (event ne sme otići napolje
 * ako se transakcija poništi).
 *
 * IDEMPOTENTNOST: idempotencyKey generiše klijent PRE prvog pokušaja i
 * šalje isti ključ na svaki retry. `@@unique([restaurantId, idempotencyKey])`
 * na bazi garantuje da dupli zahtev (duplo kliknuto dugme, mrežni retry,
 * ponovljen SSE event) nikad ne kreira drugu porudžbinu — drugi poziv sa
 * istim ključem vraća VEĆ POSTOJEĆU porudžbinu umesto greške, što je
 * očekivano ponašanje za retry.
 */
export async function submitOrder(ctx: AuthContext, orderId: string, input: SubmitOrderInput) {
  // Idempotency provera PRE transakcije: ako je ključ već upotrebljen za
  // ORDER ID koji nije ovaj, to je ili greška klijenta (ponovna upotreba
  // ključa za drugu porudžbinu) ili legitiman retry iste porudžbine —
  // razlikujemo ih po orderId podudaranju.
  const existingWithKey = await prisma.order.findFirst({
    where: { restaurantId: ctx.restaurantId, idempotencyKey: input.idempotencyKey },
  });
  if (existingWithKey) {
    if (existingWithKey.id === orderId) {
      // Retry iste operacije — vrati postojeće stanje, ne greši.
      return getOrder(ctx, orderId);
    }
    throw new Error("Idempotency ključ je već upotrebljen za drugu porudžbinu");
  }

  const order = await getOwnedDraftOrder(ctx, orderId);

  const items = await prisma.orderItem.findMany({ where: { orderId } });
  if (items.length === 0) {
    throw new Error("Porudžbina nema nijednu stavku");
  }

  const submitted = await prisma.$transaction(async (tx) => {
    // Re-snapshot cene/naziva u trenutku SLANJA (ne samo dodavanja u draft)
    // — ako je cena promenjena u međuvremenu kroz Admin Panel, porudžbina
    // odlazi kuhinji/šanku sa cenom koja važi SADA, ne sa zastarelom.
    for (const item of items) {
      if (!item.menuItemId) continue;
      const currentMenuItem = await tx.menuItem.findUnique({ where: { id: item.menuItemId } });
      if (currentMenuItem && Number(currentMenuItem.price) !== Number(item.price)) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { price: currentMenuItem.price, taxRate: currentMenuItem.taxRate },
        });
      }
    }

    await tx.orderItem.updateMany({ where: { orderId }, data: { status: "SUBMITTED" } });

    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: {
        status: "SUBMITTED",
        idempotencyKey: input.idempotencyKey,
        submittedAt: new Date(),
      },
    });

    await tx.orderEvent.create({
      data: { orderId, type: "order_submitted", createdBy: ctx.employeeId, payload: { itemCount: items.length } },
    });

    return updatedOrder;
  });

  await recordAuditEntry(ctx, {
    entityType: "Order",
    entityId: orderId,
    action: "order.submitted",
    newValue: { itemCount: items.length },
  });

  // Real-time obaveštenje TEK posle uspešnog COMMIT-a.
  await ssePublisher.publish({
    type: "order.submitted",
    restaurantId: ctx.restaurantId,
    locationId: submitted.locationId,
    payload: { orderId, tableId: submitted.tableId },
    occurredAt: new Date().toISOString(),
  });

  return getOrder(ctx, orderId);
}
