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
import { getBlockedAvailability } from "../menu/availability-service";
import { assertIngredientStockAvailable } from "../inventory/ingredient-service";
import type { OpenOrderInput, AddOrderItemInput, UpdateOrderItemInput, UpdateOrderItemModifiersInput, SubmitOrderInput } from "@rcs/shared";

const ORDER_ITEM_INCLUDE = {
  modifiers: { orderBy: { sortOrder: "asc" as const } },
};

// VIŠE-KRUŽNO NARUČIVANJE: porudžbina prima NOVE (DRAFT) stavke sve dok
// nije zatvorena (COMPLETED/CANCELLED) — "poslato" NIKAD ne znači "ova
// porudžbina više ne prima stavke", znači SAMO "trenutno neposlate stavke
// su poslate". Ista lista statusa kao PAYABLE_STATUSES u billing-service.ts
// (svaki status u kom porudžbina još nije naplaćena/otkazana), plus DRAFT.
const OPEN_ORDER_STATUSES = new Set(["DRAFT", "SUBMITTED", "ACCEPTED", "PREPARING", "READY", "SERVED"]);

/**
 * Isti produkcioni incident/rešenje kao billing-service.ts TX_OPTIONS (vidi
 * opširnu napomenu tamo). submitOrder radi analogno puno uzastopnih round-
 * trip-ova unutar JEDNE transakcije (re-snapshot cene/dodataka po stavci,
 * provera dostupnosti/zalihe, DRAFT->SUBMITTED, OrderItemStation redovi,
 * audit) — na porudžbini sa više stavki ovo može preći Prisma-in
 * podrazumevani 5s rok. Nikad se ne premešta bilo šta van transakcije —
 * samo joj se da dovoljno vremena.
 */
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

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

/**
 * VIŠE-KRUŽNO NARUČIVANJE: zamenjuje raniju getOwnedDraftOrder. Porudžbina
 * je "otvorena" za DODAVANJE novih (DRAFT) stavki u SVAKOM statusu osim
 * COMPLETED/CANCELLED — poslata porudžbina i dalje prima naredne krugove
 * (samo NOVE stavke ulaze kao DRAFT, već poslate ostaju netaknute, vidi
 * addItem/updateItem/removeItem ispod za per-stavka DRAFT čuvare).
 *
 * Vlasništvo (requireDraftOwnership) se primenjuje ISKLJUČIVO dok porudžbina
 * JOŠ NIJE ni jednom poslata (status === DRAFT) — ista zaštita kao pre,
 * sprečava da dva konobara istovremeno menjaju isti još-neposlati korpu.
 * Čim je porudžbina BAR JEDNOM poslata, svaki WAITER sa pristupom lokaciji
 * sme da doda naredni krug — isto pravilo kao void/transfer/naplata
 * (order-access.ts/transfer-service.ts: "SUBMITTED+ porudžbina NEMA
 * per-konobar vlasništvo").
 */
async function getOwnedOpenOrder(ctx: AuthContext, orderId: string) {
  requireOrderOperator(ctx);
  const order = await prisma.order.findFirst({ where: { id: orderId, ...scopeToRestaurant(ctx) } });
  if (!order) throw new Error("Porudžbina nije pronađena");
  // Restoran može imati više lokacija — restaurantId scoping sam po sebi
  // NIJE dovoljan (zaposleni sa pristupom Lokaciji A ne sme dotaći
  // porudžbinu Lokacije B u istom restoranu).
  requireLocationAccess(ctx, order.locationId);
  if (!OPEN_ORDER_STATUSES.has(order.status)) {
    // Zatvorena (naplaćena/otkazana) porudžbina se NIKAD ne menja ovim
    // putem. Zabeleži pokušaj kao evidenciju (specifikacija #11) — bez
    // obzira da li je posledica zastarelog UI-ja na klijentu ili stvarnog
    // pokušaja zaobilaženja void toka, obrazac ponavljanja postaje vidljiv
    // u Fazi 5.
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
    throw new Error("Porudžbina je zatvorena (naplaćena/otkazana) — ne može se menjati");
  }
  if (order.status === "DRAFT") requireDraftOwnership(ctx, order.openedBy);
  return order;
}

/**
 * Zajednička audit evidencija za SVAKI odbijen pokušaj izmene VEĆ POSLATE
 * stavke ovim (ne-Void) putem — isti obrazac/kategorija kao odbijanje na
 * nivou cele zatvorene porudžbine u getOwnedOpenOrder iznad. entityId
 * namerno ostaje orderId (ne itemId), isti obrazac na koji se oslanja
 * postojeći "UNAUTHORIZED_ATTEMPTS" signal u audit-service.ts.
 */
async function recordItemMutationRejected(
  ctx: AuthContext,
  order: { locationId: string },
  orderId: string,
  itemId: string,
  itemStatus: string
): Promise<void> {
  await recordAuditEntry(ctx, {
    entityType: "Order",
    entityId: orderId,
    action: "order_item.mutation_attempt_rejected",
    newValue: { itemId, itemStatus },
    locationId: order.locationId,
    category: "UNAUTHORIZED_ATTEMPT",
    severity: "WARNING",
    isSuspicious: true,
  });
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
  const order = await getOwnedOpenOrder(ctx, orderId);

  const menuItem = await prisma.menuItem.findFirst({
    where: { id: input.menuItemId, restaurantId: ctx.restaurantId, deletedAt: null },
  });
  if (!menuItem) throw new Error("Artikal nije pronađen");
  if (!menuItem.isActive || !menuItem.isAvailable) {
    throw new Error("Artikal trenutno nije dostupan za prodaju");
  }

  // Operativna dostupnost (Kuhinja/Šank "NIJE DOSTUPNO") — POTPUNO odvojeno
  // od zalihe, vidi availability-service.ts. Tvrd blok, nikad samo upozorenje.
  const blockedByLocation = await getBlockedAvailability(ctx.restaurantId, order.locationId, [menuItem.id]);
  const blocked = blockedByLocation.get(menuItem.id);
  if (blocked) {
    throw new Error(`Artikal "${menuItem.name}" je trenutno nedostupan (${blocked.reasonLabel}) — kuhinja/šank ga je privremeno isključila.`);
  }

  // P1.7: DIRECT_STOCK stock level NEVER blocks add-to-cart (a normal sale
  // must never be rejected because recorded stock is behind physical
  // reality) — the old assertStockAvailable check is gone. The ONLY
  // remaining pre-check is assertIngredientStockAvailable's
  // RecipeNotConfiguredError ("Normativ nije podešen") — a missing
  // NORMATIVE is a configuration failure TableCore genuinely cannot deduct
  // against, not a stock shortage, and that block stays (audit §3/§4).
  await assertIngredientStockAvailable(prisma, {
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
 * za DRAFT stavke — poslata (ili kasnija) stavka se NE menja ovim putem
 * (eksplicitna per-stavka provera ispod, isto pravilo kao updateItem/
 * removeItem), da izmena dodataka nikad tiho ne iskrivi već poslat KDS
 * tiket/istoriju.
 */
export async function updateItemModifiers(
  ctx: AuthContext,
  orderId: string,
  itemId: string,
  input: UpdateOrderItemModifiersInput
) {
  const modifiersOrder = await getOwnedOpenOrder(ctx, orderId);
  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new Error("Stavka nije pronađena");
  if (item.status !== "DRAFT") {
    await recordItemMutationRejected(ctx, modifiersOrder, orderId, itemId, item.status);
    throw new Error("Stavka je već poslata kuhinji/šanku — dodaci poslate stavke se ne mogu menjati ovim putem");
  }
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
  const order = await getOwnedOpenOrder(ctx, orderId);

  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new Error("Stavka nije pronađena");
  // VIŠE-KRUŽNO NARUČIVANJE: ova putanja menja SAMO neposlate (DRAFT)
  // stavke. Već poslata stavka (bilo iz ranijeg kruga ili upravo poslata)
  // se NIKAD ne menja in-place ovim putem — količina/cena poslate stavke
  // ide isključivo kroz controlled void (voidOrderItem, Faza 4); "još jedan
  // Omlet" posle prvog slanja postaje NOV, zaseban DRAFT red preko addItem
  // (vidi order-client.tsx addItemWithModifiers — poklapanje za
  // inkrementiranje sad namerno gleda SAMO postojeće DRAFT redove).
  if (item.status !== "DRAFT") {
    await recordItemMutationRejected(ctx, order, orderId, itemId, item.status);
    throw new Error("Stavka je već poslata kuhinji/šanku — količina poslate stavke se menja samo kroz Poništi (Void)");
  }

  // P3.3: samo kad se KOLIČINA UVEĆAVA i artikal ima poznat menuItemId —
  // smanjenje/uklanjanje je uvek dozvoljeno (specifikacija #20), i ne
  // proverava se ništa kad quantity uopšte nije deo ovog patch-a.
  if (input.quantity !== undefined && input.quantity > item.quantity && item.menuItemId) {
    const menuItem = await prisma.menuItem.findUnique({ where: { id: item.menuItemId }, select: { id: true, name: true } });
    if (menuItem) {
      // Operativna dostupnost — isti tvrd blok kao addItem (nikad samo
      // upozorenje), primenjen SAMO na povećanje količine (smanjenje uvek
      // dozvoljeno, isti duh kao ostatak ove funkcije).
      const blockedByLocation = await getBlockedAvailability(ctx.restaurantId, order.locationId, [menuItem.id]);
      const blocked = blockedByLocation.get(menuItem.id);
      if (blocked) {
        throw new Error(`Artikal "${menuItem.name}" je trenutno nedostupan (${blocked.reasonLabel}) — količina se ne može povećati.`);
      }

      // P1.7: only the RecipeNotConfiguredError check remains — see addItem.
      await assertIngredientStockAvailable(prisma, {
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
  const order = await getOwnedOpenOrder(ctx, orderId);

  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw new Error("Stavka nije pronađena");
  // VIŠE-KRUŽNO NARUČIVANJE: uklanjanje ovim putem je dozvoljeno SAMO za
  // stavku koja je I DALJE DRAFT (nikad poslata kuhinji/šanku, bez obzira
  // da li je porudžbina u celini već poslata jedan ili više puta ranije) —
  // fizičko brisanje je bezbedno SAMO za takvu stavku. Već poslata stavka
  // (iz ovog ili ranijeg kruga) ide kroz sasvim drugu putanju (Poništi/
  // Void, Faza 4), NIKAD ovom funkcijom — vidi pravilo "poslata stavka se
  // ne menja in-place".
  if (item.status !== "DRAFT") {
    await recordItemMutationRejected(ctx, order, orderId, itemId, item.status);
    throw new Error("Stavka je već poslata kuhinji/šanku — koristi Poništi (Void) umesto uklanjanja");
  }

  await prisma.$transaction(async (tx) => {
    await tx.orderItem.delete({ where: { id: itemId } });
    await tx.orderEvent.create({
      data: { orderId, type: "item_removed", createdBy: ctx.employeeId, payload: { itemId, name: item.name } },
    });
  });
}

/**
 * Slanje porudžbine — jedina kritična transakcija u Fazi 3, PROŠIRENA u
 * Fazi 9 za VIŠE-KRUŽNO NARUČIVANJE: "poslato" NIKAD ne znači "ova
 * porudžbina više ne prima stavke" — samo "trenutno neposlate (DRAFT)
 * stavke su poslate". Ova funkcija se sme pozivati proizvoljan broj puta na
 * istoj porudžbini (svaki put kad postoji bar jedna nova DRAFT stavka);
 * SVAKI poziv obrađuje ISKLJUČIVO stavke koje su TRENUTNO DRAFT — već
 * poslate/spremljene/servirane/plaćene/poništene stavke iz ranijih krugova
 * se NIKAD ne dodiruju (nema ponovnog OrderItemStation reda, nema ponovnog
 * KDS tiketa, nema promene cene već poslate stavke).
 *
 * Redosled je namerno: validacija → transakcija → commit → (Faza 4+:
 * pokušaj štampe VAN transakcije, Faza 6) → real-time obaveštenje. Real-time
 * publish je posle uspešnog COMMIT-a, nikad unutar transakcije (event ne
 * sme otići napolje ako se transakcija poništi).
 *
 * IDEMPOTENTNOST — PRVO slanje: idempotencyKey generiše klijent PRE prvog
 * pokušaja i šalje isti ključ na svaki retry. `@@unique([restaurantId,
 * idempotencyKey])` na bazi garantuje da dupli zahtev (duplo kliknuto
 * dugme, mrežni retry, ponovljen SSE event) nikad ne kreira drugu
 * porudžbinu — drugi poziv sa istim ključem vraća VEĆ POSTOJEĆU porudžbinu
 * umesto greške.
 *
 * IDEMPOTENTNOST — NAREDNI krugovi: Order.idempotencyKey je JEDNA kolona,
 * već trajno zauzeta PRVIM slanjem — ne može ponovo poslužiti kao ključ za
 * naredne krugove. Umesto toga, sam atomski "obradi SAMO trenutno DRAFT
 * stavke" upit ispod JE idempotentan po konstrukciji: dupli/konkurentni
 * poziv za isti krug nalazi NULA preostalih DRAFT stavki (već ih je
 * obradio prvi pobednik) i bezbedno se vraća bez greške, umesto duplog
 * slanja/duplog OrderItemStation reda.
 */
export async function submitOrder(ctx: AuthContext, orderId: string, input: SubmitOrderInput) {
  const order = await getOwnedOpenOrder(ctx, orderId);
  const isFirstSubmission = order.status === "DRAFT";

  if (isFirstSubmission) {
    // Idempotency provera PRE transakcije, SAMO za prvo slanje — ako je
    // ključ već upotrebljen za ORDER ID koji nije ovaj, to je ili greška
    // klijenta (ponovna upotreba ključa za drugu porudžbinu) ili legitiman
    // retry iste porudžbine — razlikujemo ih po orderId podudaranju.
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
  }

  const submitted = await prisma.$transaction(async (tx) => {
    // SAMO trenutno DRAFT stavke — ovo je i selekcija ZA slanje i atomska
    // idempotency brava (vidi napomenu iznad) u jednom.
    const items = await tx.orderItem.findMany({ where: { orderId, status: "DRAFT" } });
    if (items.length === 0) {
      if (isFirstSubmission) throw new Error("Porudžbina nema nijednu stavku");
      // Naredni krug bez ijedne nove stavke (dupli/konkurentni poziv, ili
      // zastareo UI) — bezbedan no-op, NIKAD greška koja bi sugerisala da
      // je nešto pošlo naopako.
      return null;
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

    // P1.7: DIRECT_STOCK stock level never blocks submit — the old
    // assertStockAvailable aggregate check is gone (see addItem). The only
    // remaining pre-send check is assertIngredientStockAvailable's
    // RecipeNotConfiguredError ("Normativ nije podešen"), still aggregated
    // by menuItemId across the WHOLE order first (two lines of the same
    // item with different P3.2 modifiers, e.g. Burger+sir ×2 and
    // Burger+slanina ×2, must be summed — kept for correctness even though
    // the aggregate no longer feeds a stock check) — internally
    // assertIngredientStockAvailable re-aggregates PO SIROVINI across every
    // recipe-governed line, the "Omlet + Omlet sa sirom share eggs" case.
    const stockRequirements = items
      .filter((item) => item.menuItemId)
      .map((item) => {
        const currentMenuItem = menuItemById.get(item.menuItemId!);
        return { menuItemId: item.menuItemId!, name: currentMenuItem?.name ?? item.name, quantity: item.quantity };
      });

    // Operativna dostupnost — SVEŽA, ISPOD zaključane submit transakcije
    // provera (isto mesto kao stockRequirements iznad) za SVAKU stavku u
    // porudžbini. Konobar je mogao dodati stavku u DRAFT PRE nego što je
    // kuhinja/šank u međuvremenu označila artikal nedostupnim — submit tada
    // MORA odbiti CEO zahtev sa jasnom porukom (transakcija se poništava,
    // ništa se ne šalje kuhinji/šanku), NIKAD tiho preskočiti tu stavku niti
    // delimično poslati porudžbinu.
    const menuItemIdsInOrder = [...new Set(stockRequirements.map((r) => r.menuItemId))];
    const blockedByLocation = await getBlockedAvailability(ctx.restaurantId, order.locationId, menuItemIdsInOrder);
    if (blockedByLocation.size > 0) {
      const blockedNames = stockRequirements
        .filter((r) => blockedByLocation.has(r.menuItemId))
        .map((r) => `${r.name} (${blockedByLocation.get(r.menuItemId)!.reasonLabel})`);
      throw new Error(
        `Porudžbina sadrži artikal(e) koje je kuhinja/šank u međuvremenu označila nedostupnim: ${blockedNames.join(", ")}. Ukloni ih pre slanja.`
      );
    }

    await assertIngredientStockAvailable(tx, { restaurantId: ctx.restaurantId, locationId: order.locationId, requirements: stockRequirements });

    // Precizno po ID-u (ne po statusu porudžbine) — VIŠE-KRUŽNO NARUČIVANJE:
    // `items` je već filtrirano na DRAFT iznad, pa je ovo TAČNO skup stavki
    // OVOG kruga, ni jedna više. Već poslate/spremne/servirane/plaćene
    // stavke iz ranijih krugova se OVIM ne dodiruju.
    const draftItemIds = items.map((item) => item.id);
    const submittedAt = new Date();
    await tx.orderItem.updateMany({ where: { id: { in: draftItemIds } }, data: { status: "SUBMITTED", submittedAt } });
    await tx.orderItem.updateMany({
      where: { id: { in: draftItemIds }, preparationStation: "NONE" },
      data: { status: "SERVED" },
    });

    // Novi OrderItemStation redovi SAMO za stavke OVOG kruga — nikad za
    // ranije poslate stavke (koje već imaju svoje, ne diramo ih ovde).
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

    // Order-nivo polja (status/idempotencyKey/submittedAt = vreme PRVOG
    // slanja) se postavljaju SAMO pri prvom slanju — naredni krug ih
    // ostavlja potpuno netaknutim (porudžbina je već "poslata", ostaje u
    // svom trenutnom, možda i dalje naprednijem statusu — npr. ACCEPTED/
    // PREPARING/READY/SERVED ako je kuhinja već napredovala raniji krug).
    const updatedOrder = isFirstSubmission
      ? await tx.order.update({
          where: { id: orderId },
          data: { status: "SUBMITTED", idempotencyKey: input.idempotencyKey, submittedAt },
        })
      : order;

    await tx.orderEvent.create({
      data: {
        orderId,
        type: isFirstSubmission ? "order_submitted" : "order_items_resubmitted",
        createdBy: ctx.employeeId,
        payload: { itemCount: items.length, itemIds: draftItemIds },
      },
    });

    await recordAuditEntry(ctx, {
      entityType: "Order",
      entityId: orderId,
      action: isFirstSubmission ? "order.submitted" : "order.items_resubmitted",
      newValue: { itemCount: items.length, itemIds: draftItemIds },
      locationId: order.locationId,
    }, tx);

    return { order: updatedOrder, draftItemIds };
  }, TX_OPTIONS);

  if (!submitted) {
    // Ništa novo za slanje — vidi napomenu unutar transakcije. Vraća
    // trenutno (već ispravno) stanje, bez greške.
    return getOrder(ctx, orderId);
  }

  // Real-time obaveštenje TEK posle uspešnog COMMIT-a.
  await ssePublisher.publish({
    type: "order.submitted",
    restaurantId: ctx.restaurantId,
    locationId: submitted.order.locationId,
    payload: { orderId, tableId: submitted.order.tableId },
    occurredAt: new Date().toISOString(),
  });

  // Faza 6: dispatch kuhinjskog/šank PrintJob-a TEK POSLE commit-a, van
  // transakcije — neuspeh štampe NIKAD ne sme oboriti već poslatu porudžbinu
  // niti KDS stanje (OrderItemStation je već zapisan gore, nezavisno od ovoga).
  // `orderItemIds` ograničava tiket ISKLJUČIVO na stavke OVOG kruga (nikad
  // ranije poslate) — vidi print-service.ts. `dispatchKeySuffix` je
  // izostavljen za PRVO slanje (nepromenjen format ključa, potpuna
  // unazadna kompatibilnost), a za NAREDNE krugove je idempotencyKey OVOG
  // zahteva — različit ključ = odvojen, nov tiket po krugu; isti ključ na
  // retry = isti tiket, nikad dupliran.
  try {
    await dispatchStationPrintJobs(ctx, orderId, {
      orderItemIds: submitted.draftItemIds,
      dispatchKeySuffix: isFirstSubmission ? undefined : input.idempotencyKey,
    });
  } catch (err) {
    console.error("[printing] dispatchStationPrintJobs failed for order", orderId, err);
  }

  return getOrder(ctx, orderId);
}
