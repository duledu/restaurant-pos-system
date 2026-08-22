import { prisma, Prisma } from "@rcs/db";
import { requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import { ssePublisher } from "../realtime/sse-publisher";
import { getActiveShift } from "../shifts/shift-service";
import { getTable } from "../tables/table-service";
import { stationsForPreparation } from "../production/station-state";
import { dispatchStationPrintJobs } from "../printing/print-service";
import { requireDraftOwnership, requireOrderOperator } from "./order-access";
import { getModifierGroupsForMenuItem, validateAndPriceModifierSelection } from "../menu/modifier-service";
import { assertStockAvailable } from "../inventory/inventory-service";
import type { OpenOrderInput, AddOrderItemInput, UpdateOrderItemInput, UpdateOrderItemModifiersInput, SubmitOrderInput } from "@rcs/shared";

const ORDER_ITEM_INCLUDE = {
  modifiers: { orderBy: { sortOrder: "asc" as const } },
};

/**
 * Otvara NOVU draft porudžbinu za sto (ili vraća postojeći DRAFT ako već
 * postoji za taj sto — konobar se ne kažnjava dvostrukim klikom na isti
 * sto). Zahteva aktivnu smenu na lokaciji stola (pravilo iz plana: bez
 * smene nema unosa porudžbina).
 */
export async function openOrder(ctx: AuthContext, input: OpenOrderInput) {
  requireOrderOperator(ctx);
  const table = await getTable(ctx, input.tableId);
  const shift = await getActiveShift(ctx, table.floor.locationId);
  if (!shift) {
    throw new Error("Nema aktivne smene na ovoj lokaciji — otvori smenu pre unosa porudžbina");
  }

  // Ne samo DRAFT — I poslata, još nenaplaćena porudžbina za ovaj sto se
  // vraća umesto da se kreira nova. Bez ovoga bi ponovni tap na zauzet sto
  // (dok je porudžbina već SUBMITTED/PREPARING/...) tiho otvorio DRUGU
  // paralelnu porudžbinu na istom stolu — kritično za Fazu 2 gde račun mora
  // nedvosmisleno odgovarati JEDNOJ porudžbini po stolu.
  const existingActive = await prisma.order.findFirst({
    where: { ...scopeToRestaurant(ctx), tableId: input.tableId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
  });
  if (existingActive) {
    if (existingActive.status === "DRAFT") requireDraftOwnership(ctx, existingActive.openedBy);
    return existingActive;
  }

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        restaurantId: ctx.restaurantId,
        locationId: table.floor.locationId,
        tableId: input.tableId,
        shiftId: shift.id,
        openedBy: ctx.employeeId,
        guestCount: input.guestCount,
      },
    });

    await tx.restaurantTable.update({ where: { id: input.tableId }, data: { status: "OCCUPIED" } });
    await tx.orderEvent.create({
      data: { orderId: order.id, type: "order_opened", createdBy: ctx.employeeId },
    });
    return order;
  });
}

async function getOwnedDraftOrder(ctx: AuthContext, orderId: string) {
  requireOrderOperator(ctx);
  const order = await prisma.order.findFirst({ where: { id: orderId, ...scopeToRestaurant(ctx) } });
  if (!order) throw new Error("Porudžbina nije pronađena");
  // Restoran može imati više lokacija — restaurantId scoping sam po sebi
  // NIJE dovoljan (zaposleni sa pristupom Lokaciji A ne sme dotaći
  // porudžbinu Lokacije B u istom restoranu).
  requireLocationAccess(ctx, order.locationId);
  if (order.status !== "DRAFT") {
    // Poslata porudžbina se NIKAD ne menja ovim putem (add/update/remove) —
    // to je bez izuzetka putanja za controlled void (voidOrderItem, Faza 4).
    // Zabeleži pokušaj kao evidenciju (specifikacija #11) — bez obzira da li
    // je posledica zastarelog UI-ja na klijentu ili stvarnog pokušaja
    // zaobilaženja void toka, obrazac ponavljanja postaje vidljiv u Fazi 5.
    await recordAuditEntry(ctx, {
      entityType: "Order",
      entityId: orderId,
      action: "order_item.mutation_attempt_rejected",
      newValue: { orderStatus: order.status },
      locationId: order.locationId,
      category: "UNAUTHORIZED_ATTEMPT",
      severity: "WARNING",
      isSuspicious: true,
    });
    throw new Error("Porudžbina više nije u nacrtu — ne može se menjati ovim putem");
  }
  requireDraftOwnership(ctx, order.openedBy);
  return order;
}

export async function getOrder(ctx: AuthContext, orderId: string) {
  requireOrderOperator(ctx);
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...scopeToRestaurant(ctx) },
    include: { items: { include: ORDER_ITEM_INCLUDE, orderBy: { createdAt: "asc" } }, table: true },
  });
  if (!order) throw new Error("Porudžbina nije pronađena");
  requireLocationAccess(ctx, order.locationId);
  if (order.status === "DRAFT") requireDraftOwnership(ctx, order.openedBy);
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

  // P3.3: sveža provera dostupnosti u trenutku dodavanja — SAMO validacija,
  // NIKAD ne menja currentStock (to ostaje isključivo posao Payment-a, vidi
  // assertStockAvailable). Ne tretira postojeće draft redove (ni ovog ni
  // drugih konobara) kao "rezervisanu" zalihu (specifikacija #8/#9/#10/#20)
  // — ovo je samo trenutna provera "da li je OVAJ zahtev razuman SADA".
  await assertStockAvailable(prisma, {
    restaurantId: ctx.restaurantId,
    locationId: order.locationId,
    requirements: [{ menuItemId: menuItem.id, name: menuItem.name, quantity: input.quantity }],
  });

  // P3.2: klijent šalje SAMO identitete izabranih opcija — server učitava
  // grupe STVARNO vezane za ovaj artikal i sam presuđuje cenu (specifikacija
  // #12/#13). `OrderItem.price` postaje EFEKTIVNA jedinična cena (osnovna +
  // izabrani dodaci) — vidi napomenu na vrhu schema.prisma modela.
  const groups = await getModifierGroupsForMenuItem(ctx.restaurantId, menuItem.id);
  const { priceDelta, snapshotRows } = validateAndPriceModifierSelection(groups, input.modifierOptionIds);
  const effectivePrice = new Prisma.Decimal(menuItem.price).add(priceDelta).toDecimalPlaces(2);

  // Snapshot se pravi OVDE, pri dodavanju u draft — ne pri submit-u — jer
  // konobar treba da vidi tačnu cenu u pregledu porudžbine pre slanja.
  // Cena se PONOVO snapshot-uje (ne menja) pri submitOrder ispod, na
  // slučaj da je cena (osnovna ili dodataka) promenjena između dodavanja u
  // draft i slanja.
  return prisma.$transaction(async (tx) => {
    const item = await tx.orderItem.create({
      data: {
        orderId,
        menuItemId: menuItem.id,
        name: menuItem.name,
        price: effectivePrice,
        taxRate: menuItem.taxRate,
        quantity: input.quantity,
        note: input.note,
        preparationStation: menuItem.preparationStation,
        modifiers: snapshotRows.length > 0 ? { createMany: { data: snapshotRows } } : undefined,
      },
      include: ORDER_ITEM_INCLUDE,
    });

    await tx.orderEvent.create({
      data: {
        orderId,
        type: "item_added",
        createdBy: ctx.employeeId,
        payload: {
          menuItemId: menuItem.id,
          name: menuItem.name,
          quantity: input.quantity,
          modifiers: snapshotRows.map((r) => r.optionName),
        },
      },
    });
    return item;
  });
}

/**
 * Izmena izabranih dodataka na VEĆ POSTOJEĆOJ draft stavci — potpuna zamena
 * skupa (ne parcijalni patch), ista validacija/cenovanje kao addItem. Samo
 * za DRAFT stavke (getOwnedDraftOrder već to garantuje) — poslata stavka se
 * ne menja ovim putem, isto pravilo kao updateItem/removeItem.
 */
export async function updateItemModifiers(
  ctx: AuthContext,
  orderId: string,
  itemId: string,
  input: UpdateOrderItemModifiersInput
) {
  await getOwnedDraftOrder(ctx, orderId);
  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new Error("Stavka nije pronađena");
  if (!item.menuItemId) throw new Error("Stavka nema povezan artikal iz menija");

  const menuItem = await prisma.menuItem.findFirst({ where: { id: item.menuItemId, restaurantId: ctx.restaurantId } });
  if (!menuItem) throw new Error("Artikal nije pronađen");

  const groups = await getModifierGroupsForMenuItem(ctx.restaurantId, menuItem.id);
  const { priceDelta, snapshotRows } = validateAndPriceModifierSelection(groups, input.modifierOptionIds);
  const effectivePrice = new Prisma.Decimal(item.price).sub(await currentModifierTotal(itemId)).add(priceDelta).toDecimalPlaces(2);

  return prisma.$transaction(async (tx) => {
    await tx.orderItemModifier.deleteMany({ where: { orderItemId: itemId } });
    if (snapshotRows.length > 0) {
      await tx.orderItemModifier.createMany({ data: snapshotRows.map((r) => ({ ...r, orderItemId: itemId })) });
    }
    const updated = await tx.orderItem.update({
      where: { id: itemId },
      data: { price: effectivePrice },
      include: ORDER_ITEM_INCLUDE,
    });
    await tx.orderEvent.create({
      data: {
        orderId,
        type: "item_modifiers_updated",
        createdBy: ctx.employeeId,
        payload: { itemId, modifiers: snapshotRows.map((r) => r.optionName) },
      },
    });
    return updated;
  });
}

async function currentModifierTotal(orderItemId: string): Promise<Prisma.Decimal> {
  const rows = await prisma.orderItemModifier.findMany({ where: { orderItemId }, select: { priceDelta: true } });
  return rows.reduce((sum, r) => sum.add(r.priceDelta), new Prisma.Decimal(0));
}

export async function updateItem(ctx: AuthContext, orderId: string, itemId: string, input: UpdateOrderItemInput) {
  const order = await getOwnedDraftOrder(ctx, orderId);

  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new Error("Stavka nije pronađena");

  // P3.3: samo kad se KOLIČINA UVEĆAVA i artikal ima poznat menuItemId —
  // smanjenje/uklanjanje je uvek dozvoljeno (specifikacija #20), i ne
  // proverava se ništa kad quantity uopšte nije deo ovog patch-a.
  if (input.quantity !== undefined && input.quantity > item.quantity && item.menuItemId) {
    const menuItem = await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { id: true, name: true } });
    if (menuItem) {
      await assertStockAvailable(prisma, {
        restaurantId: ctx.restaurantId,
        locationId: order.locationId,
        requirements: [{ menuItemId: menuItem.id, name: menuItem.name, quantity: input.quantity }],
      });
    }
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.orderItem.update({ where: { id: itemId }, data: input });
    await tx.orderEvent.create({
      data: { orderId, type: "item_updated", createdBy: ctx.employeeId, payload: input },
    });
    return updated;
  });
}

export async function removeItem(ctx: AuthContext, orderId: string, itemId: string) {
  await getOwnedDraftOrder(ctx, orderId);

  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new Error("Stavka nije pronađena");

  // Stavka je I DALJE u DRAFT-u (nikad poslata kuhinji/šanku) — fizičko
  // brisanje je bezbedno ovde. Nakon submit-a, uklanjanje stavke ide kroz
  // sasvim drugu putanju (item_cancel_requested/approved, Faza 5), NIKAD
  // ovom funkcijom — vidi pravilo "poslata stavka se ne menja in-place".
  await prisma.$transaction(async (tx) => {
    await tx.orderItem.delete({ where: { id: itemId } });
    await tx.orderEvent.create({
      data: { orderId, type: "item_removed", createdBy: ctx.employeeId, payload: { itemId, name: item.name } },
    });
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

  const submitted = await prisma.$transaction(async (tx) => {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    if (items.length === 0) {
      throw new Error("Porudžbina nema nijednu stavku");
    }

    // Re-snapshot cene/naziva u trenutku SLANJA (ne samo dodavanja u draft)
    // — ako je osnovna cena ILI cena nekog dodatka promenjena u međuvremenu
    // kroz Admin Panel, porudžbina odlazi kuhinji/šanku i na naplatu sa
    // cenom koja važi SADA, ne sa zastarelom (ista filozofija za oboje —
    // P3.2 samo proširuje postojeće ponašanje na modifikatore).
    //
    // Batch-ovano (JEDAN upit za sve MenuItem-e, JEDAN za sve
    // OrderItemModifier redove svih stavki) — ne po-stavci/po-modifikatoru,
    // jer je ovo unutar kritične submit transakcije (specifikacija #63).
    const menuItemIds = Array.from(new Set(items.map((i) => i.menuItemId).filter((id): id is string => id !== null)));
    const itemIds = items.map((i) => i.id);
    const [currentMenuItems, allModifiers] = await Promise.all([
      menuItemIds.length > 0 ? tx.menuItem.findMany({ where: { id: { in: menuItemIds } } }) : Promise.resolve([]),
      tx.orderItemModifier.findMany({ where: { orderItemId: { in: itemIds } } }),
    ]);
    const menuItemById = new Map(currentMenuItems.map((m) => [m.id, m]));
    const liveOptionIds = Array.from(new Set(allModifiers.map((m) => m.modifierOptionId).filter((id): id is string => id !== null)));
    const liveOptions = liveOptionIds.length > 0 ? await tx.modifierOption.findMany({ where: { id: { in: liveOptionIds } } }) : [];
    const liveOptionById = new Map(liveOptions.map((o) => [o.id, o]));
    const modifiersByItem = new Map<string, typeof allModifiers>();
    for (const m of allModifiers) {
      const list = modifiersByItem.get(m.orderItemId) ?? [];
      list.push(m);
      modifiersByItem.set(m.orderItemId, list);
    }

    for (const item of items) {
      if (!item.menuItemId) continue;
      const currentMenuItem = menuItemById.get(item.menuItemId);
      if (!currentMenuItem) continue; // artikal u međuvremenu obrisan — zadrži poslednji poznati snapshot

      let modifierTotal = new Prisma.Decimal(0);
      for (const m of modifiersByItem.get(item.id) ?? []) {
        // Opcija u međuvremenu deaktivirana/obrisana: nema živog izvora za
        // osvežavanje, zadržava se poslednja poznata snapshot cena — isto
        // pravilo kao "artikal obrisan" gore (nikad ne izmišljamo cenu).
        const live = m.modifierOptionId ? liveOptionById.get(m.modifierOptionId) : undefined;
        const currentDelta = live ? new Prisma.Decimal(live.priceDelta) : new Prisma.Decimal(m.priceDelta);
        modifierTotal = modifierTotal.add(currentDelta);
        if (live && !currentDelta.equals(m.priceDelta)) {
          await tx.orderItemModifier.update({ where: { id: m.id }, data: { priceDelta: currentDelta } });
        }
      }

      const newEffectivePrice = new Prisma.Decimal(currentMenuItem.price).add(modifierTotal).toDecimalPlaces(2);
      if (!newEffectivePrice.equals(item.price) || Number(currentMenuItem.taxRate) !== Number(item.taxRate)) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { price: newEffectivePrice, taxRate: currentMenuItem.taxRate },
        });
      }
    }

    // P3.3: sveža agregatna provera dostupnosti PRE slanja kuhinji/šanku —
    // VALIDACIJA SAMO, nikad ne menja currentStock (specifikacija #21/#22 —
    // Payment ostaje jedini autoritet za stvarni odbitak). Agregira SVE
    // linije po menuItemId (specifikacija #51/#63): dve linije istog
    // artikla sa različitim P3.2 modifikatorima (npr. Burger+sir ×2 i
    // Burger+slanina ×2) se sabiraju u JEDAN zahtev od 4 komada pre provere
    // — ne proveravaju se nezavisno, što bi pogrešno dozvolilo obe linije
    // kad zaliha ima samo 3.
    const stockRequirements = items
      .filter((item) => item.menuItemId)
      .map((item) => {
        const currentMenuItem = menuItemById.get(item.menuItemId!);
        return { menuItemId: item.menuItemId!, name: currentMenuItem?.name ?? item.name, quantity: item.quantity };
      });
    await assertStockAvailable(tx, { restaurantId: ctx.restaurantId, locationId: order.locationId, requirements: stockRequirements });

    await tx.orderItem.updateMany({ where: { orderId }, data: { status: "SUBMITTED" } });
    await tx.orderItem.updateMany({
      where: { orderId, preparationStation: "NONE" },
      data: { status: "SERVED" },
    });

    const stationRows = items.flatMap((item) =>
      stationsForPreparation(item.preparationStation).map((station) => ({
        orderItemId: item.id,
        station,
        status: "SUBMITTED" as const,
      }))
    );
    if (stationRows.length > 0) {
      await tx.orderItemStation.createMany({ data: stationRows });
    }

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

    await recordAuditEntry(ctx, {
      entityType: "Order",
      entityId: orderId,
      action: "order.submitted",
      newValue: { itemCount: items.length },
      locationId: order.locationId,
    }, tx);

    return updatedOrder;
  });

  // Real-time obaveštenje TEK posle uspešnog COMMIT-a.
  await ssePublisher.publish({
    type: "order.submitted",
    restaurantId: ctx.restaurantId,
    locationId: submitted.locationId,
    payload: { orderId, tableId: submitted.tableId },
    occurredAt: new Date().toISOString(),
  });

  // Faza 6: dispatch kuhinjskog/šank PrintJob-a TEK POSLE commit-a, van
  // transakcije — neuspeh štampe NIKAD ne sme oboriti već poslatu porudžbinu
  // niti KDS stanje (OrderItemStation je već zapisan gore, nezavisno od ovoga).
  try {
    await dispatchStationPrintJobs(ctx, orderId);
  } catch (err) {
    console.error("[printing] dispatchStationPrintJobs failed for order", orderId, err);
  }

  return getOrder(ctx, orderId);
}
