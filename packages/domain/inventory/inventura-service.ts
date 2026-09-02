/**
 * INVENTURA — fizičko prebrojavanje zaliha. Vidi opširnu napomenu uz
 * InventoryCountSession/InventoryCountLine u schema.prisma za pun kontekst
 * (konkurentnost, STALE detekcija, atomska potvrda).
 *
 * Pokriva ISKLJUČIVO Ingredient (sirovine, IngredientStock) i DIRECT_STOCK
 * MenuItem (gotovi proizvod na direktnoj zalihi, InventoryItem) — RECIPE i
 * NO_TRACKING artikli se odbijaju u addLines (nemaju sopstvenu, brojivu
 * zalihu — receptura je potrošnja PO PRODATOM artiklu, ne fizička roba na
 * polici; NO_TRACKING se uopšte ne prati).
 */
import { randomUUID } from "crypto";
import { prisma, Prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, ForbiddenError, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import type {
  StartInventoryCountSessionInput,
  AddInventoryCountLinesInput,
  ConfirmInventoryCountSessionInput,
} from "@rcs/shared";

const INVENTORY_COUNT = "inventory.count";
const INVENTORY_VIEW = "inventory.view";

type TxClient = Prisma.TransactionClient;

async function loadSession(ctx: AuthContext, sessionId: string) {
  const session = await prisma.inventoryCountSession.findFirst({ where: { id: sessionId, ...scopeToRestaurant(ctx) } });
  if (!session) throw new Error("Sesija inventure nije pronađena");
  requireLocationAccess(ctx, session.locationId);
  return session;
}

async function loadOpenSession(ctx: AuthContext, sessionId: string) {
  const session = await loadSession(ctx, sessionId);
  if (session.status !== "OPEN") throw new Error("Sesija je već potvrđena — redovi se više ne mogu menjati");
  return session;
}

// ── Sesije ──────────────────────────────────────────────────────────────

/**
 * Nastavlja postojeću OPEN sesiju za lokaciju ako postoji (Spec: "Unfinished
 * session can be resumed") — nikad ne kreira dve paralelne OPEN sesije za
 * istu lokaciju.
 */
export async function startOrResumeSession(ctx: AuthContext, input: StartInventoryCountSessionInput) {
  requirePermission(ctx, INVENTORY_COUNT);
  requireLocationAccess(ctx, input.locationId);

  const existing = await prisma.inventoryCountSession.findFirst({
    where: { ...scopeToRestaurant(ctx), locationId: input.locationId, status: "OPEN" },
  });
  if (existing) return getSession(ctx, existing.id);

  const created = await prisma.inventoryCountSession.create({
    data: { restaurantId: ctx.restaurantId, locationId: input.locationId, startedBy: ctx.employeeId },
  });
  await recordAuditEntry(ctx, {
    entityType: "InventoryCountSession",
    entityId: created.id,
    action: "inventory_count.started",
    newValue: { locationId: input.locationId },
    locationId: input.locationId,
  });
  return getSession(ctx, created.id);
}

export async function listSessions(ctx: AuthContext, filters: { locationId?: string } = {}) {
  requirePermission(ctx, INVENTORY_VIEW);
  if (filters.locationId) requireLocationAccess(ctx, filters.locationId);

  const sessions = await prisma.inventoryCountSession.findMany({
    where: {
      ...scopeToRestaurant(ctx),
      locationId: filters.locationId ?? { in: ctx.locationIds },
    },
    orderBy: { startedAt: "desc" },
    include: { lines: { select: { status: true } } },
    take: 100,
  });

  const employeeIds = [...new Set(sessions.flatMap((s) => [s.startedBy, s.confirmedBy]).filter((x): x is string => Boolean(x)))];
  const employees =
    employeeIds.length > 0
      ? await prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
  const nameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  return sessions.map((s) => ({
    id: s.id,
    locationId: s.locationId,
    status: s.status,
    startedByName: nameById.get(s.startedBy) ?? "?",
    startedAt: s.startedAt.toISOString(),
    confirmedByName: s.confirmedBy ? (nameById.get(s.confirmedBy) ?? "?") : null,
    confirmedAt: s.confirmedAt?.toISOString() ?? null,
    lineCount: s.lines.length,
    countedCount: s.lines.filter((l) => l.status !== "NOT_COUNTED").length,
    staleCount: s.lines.filter((l) => l.status === "STALE").length,
  }));
}

export async function getSession(ctx: AuthContext, sessionId: string) {
  requirePermission(ctx, INVENTORY_VIEW);
  const session = await prisma.inventoryCountSession.findFirst({
    where: { id: sessionId, ...scopeToRestaurant(ctx) },
    include: { lines: { orderBy: { createdAt: "asc" } } },
  });
  if (!session) throw new Error("Sesija inventure nije pronađena");
  requireLocationAccess(ctx, session.locationId);

  const menuItemIds = session.lines.filter((l) => l.menuItemId).map((l) => l.menuItemId!);
  const ingredientIds = session.lines.filter((l) => l.ingredientId).map((l) => l.ingredientId!);
  const [menuItems, ingredients] = await Promise.all([
    menuItemIds.length > 0 ? prisma.menuItem.findMany({ where: { id: { in: menuItemIds } }, select: { id: true, name: true, unit: true } }) : Promise.resolve([]),
    ingredientIds.length > 0 ? prisma.ingredient.findMany({ where: { id: { in: ingredientIds } }, select: { id: true, name: true, unit: true } }) : Promise.resolve([]),
  ]);
  const menuItemById = new Map(menuItems.map((m) => [m.id, m]));
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));

  const employeeIds = [
    ...new Set([session.startedBy, session.confirmedBy, ...session.lines.map((l) => l.countedBy)].filter((x): x is string => Boolean(x))),
  ];
  const employees =
    employeeIds.length > 0
      ? await prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
  const nameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  return {
    id: session.id,
    locationId: session.locationId,
    status: session.status,
    startedByName: nameById.get(session.startedBy) ?? "?",
    startedAt: session.startedAt.toISOString(),
    confirmedByName: session.confirmedBy ? (nameById.get(session.confirmedBy) ?? "?") : null,
    confirmedAt: session.confirmedAt?.toISOString() ?? null,
    lines: session.lines.map((l) => {
      const name = l.targetType === "MENU_ITEM" ? (menuItemById.get(l.menuItemId!)?.name ?? "?") : (ingredientById.get(l.ingredientId!)?.name ?? "?");
      const unit = l.targetType === "MENU_ITEM" ? (menuItemById.get(l.menuItemId!)?.unit ?? "kom") : (ingredientById.get(l.ingredientId!)?.unit ?? "");
      return {
        id: l.id,
        targetType: l.targetType,
        name,
        unit,
        ingredientId: l.ingredientId,
        menuItemId: l.menuItemId,
        systemQtySnapshot: l.systemQtySnapshot.toString(),
        physicalQty: l.physicalQty?.toString() ?? null,
        status: l.status,
        countedByName: l.countedBy ? (nameById.get(l.countedBy) ?? "?") : null,
        countedAt: l.countedAt?.toISOString() ?? null,
        correctionMovementId: l.correctionMovementId,
      };
    }),
  };
}

// ── Redovi ──────────────────────────────────────────────────────────────

export async function addLines(ctx: AuthContext, sessionId: string, input: AddInventoryCountLinesInput) {
  requirePermission(ctx, INVENTORY_COUNT);
  const session = await loadOpenSession(ctx, sessionId);

  return prisma.$transaction(async (tx) => {
    const createdIds: string[] = [];
    for (const target of input.targets) {
      if (target.targetType === "INGREDIENT") {
        if (!target.ingredientId) throw new Error("ingredientId je obavezan za tip INGREDIENT");
        const ingredient = await tx.ingredient.findFirst({
          where: { id: target.ingredientId, restaurantId: ctx.restaurantId, isActive: true },
        });
        if (!ingredient) throw new Error("Sirovina nije pronađena ili nije aktivna");

        const dup = await tx.inventoryCountLine.findFirst({ where: { sessionId, ingredientId: target.ingredientId } });
        if (dup) throw new Error(`Sirovina "${ingredient.name}" je već dodata u ovu sesiju`);

        const stock = await tx.ingredientStock.findUnique({
          where: { locationId_ingredientId: { locationId: session.locationId, ingredientId: target.ingredientId } },
        });
        const line = await tx.inventoryCountLine.create({
          data: {
            sessionId,
            targetType: "INGREDIENT",
            ingredientId: target.ingredientId,
            systemQtySnapshot: stock?.currentStock ?? new Prisma.Decimal(0),
          },
        });
        createdIds.push(line.id);
      } else {
        if (!target.menuItemId) throw new Error("menuItemId je obavezan za tip MENU_ITEM");
        const menuItem = await tx.menuItem.findFirst({
          where: { id: target.menuItemId, restaurantId: ctx.restaurantId, deletedAt: null },
        });
        if (!menuItem) throw new Error("Artikal nije pronađen");
        if (menuItem.inventoryTrackingMethod === "RECIPE") {
          throw new Error(`Artikal "${menuItem.name}" ima konfigurisan normativ (recepturu) — Inventura pokriva samo sirovine i artikle na direktnoj zalihi.`);
        }
        if (menuItem.inventoryTrackingMethod === "NO_TRACKING") {
          throw new Error(`Artikal "${menuItem.name}" nema uključeno praćenje zaliha — Inventura ga ne obuhvata.`);
        }

        const dup = await tx.inventoryCountLine.findFirst({ where: { sessionId, menuItemId: target.menuItemId } });
        if (dup) throw new Error(`Artikal "${menuItem.name}" je već dodat u ovu sesiju`);

        const stock = await tx.inventoryItem.findUnique({
          where: { locationId_menuItemId: { locationId: session.locationId, menuItemId: target.menuItemId } },
        });
        const line = await tx.inventoryCountLine.create({
          data: {
            sessionId,
            targetType: "MENU_ITEM",
            menuItemId: target.menuItemId,
            systemQtySnapshot: stock?.currentStock ?? new Prisma.Decimal(0),
          },
        });
        createdIds.push(line.id);
      }
    }
    return createdIds;
  });
}

export async function enterPhysicalQuantity(ctx: AuthContext, sessionId: string, lineId: string, physicalQty: number) {
  requirePermission(ctx, INVENTORY_COUNT);
  if (physicalQty < 0) throw new Error("Fizička količina ne može biti negativna");
  await loadOpenSession(ctx, sessionId);

  const line = await prisma.inventoryCountLine.findFirst({ where: { id: lineId, sessionId } });
  if (!line) throw new Error("Red nije pronađen u ovoj sesiji");

  // Status ovde je SAMO za trenutni UI prikaz tokom brojanja (poređenje sa
  // snapshot-om uzetim pri dodavanju reda) — NIJE konačna reč o korekciji.
  // STALE detekcija (nasuprot ŽIVOJ vrednosti) dešava se isključivo pri
  // confirmSession, vidi napomenu na vrhu fajla.
  const snapshot = Number(line.systemQtySnapshot);
  const status = physicalQty === snapshot ? "MATCH" : physicalQty > snapshot ? "SURPLUS" : "SHORTAGE";

  return prisma.inventoryCountLine.update({
    where: { id: lineId },
    data: { physicalQty, status, countedBy: ctx.employeeId, countedAt: new Date() },
  });
}

/** "Prebroj ponovo" — re-bazira snapshot na TRENUTNU živu vrednost i vraća red na NOT_COUNTED. */
export async function recountLine(ctx: AuthContext, sessionId: string, lineId: string) {
  requirePermission(ctx, INVENTORY_COUNT);
  const session = await loadOpenSession(ctx, sessionId);

  const line = await prisma.inventoryCountLine.findFirst({ where: { id: lineId, sessionId } });
  if (!line) throw new Error("Red nije pronađen u ovoj sesiji");

  let liveValue = new Prisma.Decimal(0);
  if (line.targetType === "MENU_ITEM") {
    const stock = await prisma.inventoryItem.findUnique({
      where: { locationId_menuItemId: { locationId: session.locationId, menuItemId: line.menuItemId! } },
    });
    liveValue = stock?.currentStock ?? new Prisma.Decimal(0);
  } else {
    const stock = await prisma.ingredientStock.findUnique({
      where: { locationId_ingredientId: { locationId: session.locationId, ingredientId: line.ingredientId! } },
    });
    liveValue = stock?.currentStock ?? new Prisma.Decimal(0);
  }

  return prisma.inventoryCountLine.update({
    where: { id: lineId },
    data: { systemQtySnapshot: liveValue, physicalQty: null, status: "NOT_COUNTED", countedBy: null, countedAt: null },
  });
}

// ── Atomske, TOCTOU-bezbedne korekcije (jedan uslovni UPSERT po redu) ────

interface AtomicCorrectionResult {
  applied: boolean;
  stockId: string;
}

/**
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE currentStock = expectedBaseline`
 * je JEDNA atomska izjava: ako red ne postoji, kreira ga direktno na
 * physicalQty (nema šta da bude "zastarelo"); ako postoji ALI se trenutna
 * vrednost razlikuje od expectedBaseline (bilo zato što je neko drugi
 * upravo prodao/primio robu), UPDATE grana WHERE uslova NE pogađa, 0 redova
 * se vraća — to je STALE detekcija bez SELECT-pa-UPDATE race prozora.
 */
async function atomicSetInventoryItemStock(
  tx: TxClient,
  params: { restaurantId: string; locationId: string; menuItemId: string; expectedBaseline: number; physicalQty: number; unit: string }
): Promise<AtomicCorrectionResult> {
  const newId = randomUUID();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO inventory_items (id, "restaurantId", "locationId", "menuItemId", "currentStock", "unit", "createdAt", "updatedAt")
    VALUES (${newId}, ${params.restaurantId}, ${params.locationId}, ${params.menuItemId}, ${params.physicalQty}::numeric, ${params.unit}, now(), now())
    ON CONFLICT ("locationId", "menuItemId")
    DO UPDATE SET "currentStock" = ${params.physicalQty}::numeric, "updatedAt" = now()
    WHERE inventory_items."currentStock" = ${params.expectedBaseline}::numeric
    RETURNING id
  `;
  if (rows.length === 1) return { applied: true, stockId: rows[0].id };
  const existing = await tx.inventoryItem.findUnique({
    where: { locationId_menuItemId: { locationId: params.locationId, menuItemId: params.menuItemId } },
    select: { id: true },
  });
  return { applied: false, stockId: existing?.id ?? "" };
}

async function atomicSetIngredientStock(
  tx: TxClient,
  params: { restaurantId: string; locationId: string; ingredientId: string; expectedBaseline: number; physicalQty: number }
): Promise<AtomicCorrectionResult> {
  const newId = randomUUID();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO ingredient_stocks (id, "restaurantId", "locationId", "ingredientId", "currentStock", "createdAt", "updatedAt")
    VALUES (${newId}, ${params.restaurantId}, ${params.locationId}, ${params.ingredientId}, ${params.physicalQty}::numeric, now(), now())
    ON CONFLICT ("locationId", "ingredientId")
    DO UPDATE SET "currentStock" = ${params.physicalQty}::numeric, "updatedAt" = now()
    WHERE ingredient_stocks."currentStock" = ${params.expectedBaseline}::numeric
    RETURNING id
  `;
  if (rows.length === 1) return { applied: true, stockId: rows[0].id };
  const existing = await tx.ingredientStock.findUnique({
    where: { locationId_ingredientId: { locationId: params.locationId, ingredientId: params.ingredientId } },
    select: { id: true },
  });
  return { applied: false, stockId: existing?.id ?? "" };
}

class StaleLineError extends Error {
  constructor(public readonly lineId: string) {
    super("STALE");
  }
}

/**
 * Potvrda cele sesije — JEDNA atomska transakcija (Spec: "no partial
 * confirmation"). Redovi bez unete fizičke količine (NOT_COUNTED) se
 * PRESKAČU — ne blokiraju potvrdu, ne dobijaju korekciju. Za svaki
 * PREBROJAN red: atomski uslovni upsert (vidi funkcije iznad) ILI proglašava
 * STALE i baca — CELA transakcija se tada poništava (Prisma $transaction
 * automatski rollback-uje na bačenu grešku), pa nijedan DRUGI red iz iste
 * potvrde ne ostaje delimično upisan. STALE oznaka na samom redu se upisuje
 * TEK POSLE, u posebnom, malom pozivu (transakcija koja ju je pokušala
 * upisati je već poništena zajedno sa svime ostalim).
 */
export async function confirmSession(ctx: AuthContext, sessionId: string, input: ConfirmInventoryCountSessionInput) {
  requirePermission(ctx, INVENTORY_COUNT);
  const session = await loadSession(ctx, sessionId);
  if (session.status !== "OPEN") throw new Error("Sesija je već potvrđena — dupla potvrda nije dozvoljena");

  const overrideSet = new Set(input.overrideStaleLineIds ?? []);
  const isOwnerAdmin = ctx.roles.some((r) => ["OWNER", "ADMIN"].includes(r));
  if (overrideSet.size > 0 && !isOwnerAdmin) {
    throw new ForbiddenError("Samo Vlasnik ili Administrator može preći preko upozorenja o promenjenom stanju");
  }

  const allLines = await prisma.inventoryCountLine.findMany({ where: { sessionId } });
  const countedLines = allLines.filter((l) => l.physicalQty !== null);

  const menuItemIds = countedLines.filter((l) => l.targetType === "MENU_ITEM").map((l) => l.menuItemId!);
  const [menuItems] = await Promise.all([
    menuItemIds.length > 0 ? prisma.menuItem.findMany({ where: { id: { in: menuItemIds } }, select: { id: true, unit: true, name: true } }) : Promise.resolve([]),
  ]);
  const menuItemById = new Map(menuItems.map((m) => [m.id, m]));

  let staleLineId: string | null = null;

  try {
    await prisma.$transaction(async (tx) => {
      // Guard protiv dvostruke konkurentne potvrde iste sesije — ISTI
      // "updateMany WHERE trenutno stanje = očekivano" obrazac kao svuda
      // drugde u projektu (billing/void/transfer).
      const guard = await tx.inventoryCountSession.updateMany({
        where: { id: sessionId, status: "OPEN" },
        data: { status: "CONFIRMED", confirmedBy: ctx.employeeId, confirmedAt: new Date() },
      });
      if (guard.count !== 1) throw new Error("Sesija je već potvrđena — dupla potvrda nije dozvoljena");

      for (const line of countedLines) {
        const isOverride = overrideSet.has(line.id);
        const physicalQty = Number(line.physicalQty);
        let expectedBaseline = Number(line.systemQtySnapshot);

        if (isOverride) {
          // OWNER/ADMIN eksplicitno prelazi preko upozorenja: baseline za
          // korekciju postaje SVEŽE pročitana živa vrednost (unutar OVE
          // transakcije), NIKAD stari snapshot niti naslepo physicalQty.
          if (line.targetType === "MENU_ITEM") {
            const live = await tx.inventoryItem.findUnique({
              where: { locationId_menuItemId: { locationId: session.locationId, menuItemId: line.menuItemId! } },
            });
            expectedBaseline = live ? Number(live.currentStock) : 0;
          } else {
            const live = await tx.ingredientStock.findUnique({
              where: { locationId_ingredientId: { locationId: session.locationId, ingredientId: line.ingredientId! } },
            });
            expectedBaseline = live ? Number(live.currentStock) : 0;
          }
        }

        const result =
          line.targetType === "MENU_ITEM"
            ? await atomicSetInventoryItemStock(tx, {
                restaurantId: ctx.restaurantId,
                locationId: session.locationId,
                menuItemId: line.menuItemId!,
                expectedBaseline,
                physicalQty,
                unit: menuItemById.get(line.menuItemId!)?.unit ?? "kom",
              })
            : await atomicSetIngredientStock(tx, {
                restaurantId: ctx.restaurantId,
                locationId: session.locationId,
                ingredientId: line.ingredientId!,
                expectedBaseline,
                physicalQty,
              });

        if (!result.applied) {
          staleLineId = line.id;
          throw new StaleLineError(line.id);
        }

        const delta = physicalQty - expectedBaseline;
        let correctionMovementId: string | null = null;
        if (delta !== 0) {
          if (line.targetType === "MENU_ITEM") {
            const mov = await tx.inventoryMovement.create({
              data: {
                restaurantId: ctx.restaurantId,
                locationId: session.locationId,
                menuItemId: line.menuItemId!,
                inventoryItemId: result.stockId,
                type: "INVENTORY_CORRECTION",
                quantityDelta: delta,
                quantityBefore: expectedBaseline,
                quantityAfter: physicalQty,
                employeeId: ctx.employeeId,
                reason: "Inventura — korekcija na osnovu fizičkog prebrojavanja",
                referenceType: "INVENTORY_COUNT",
                referenceId: sessionId,
              },
            });
            correctionMovementId = mov.id;
          } else {
            const mov = await tx.ingredientMovement.create({
              data: {
                restaurantId: ctx.restaurantId,
                locationId: session.locationId,
                ingredientId: line.ingredientId!,
                ingredientStockId: result.stockId,
                type: "INVENTORY_CORRECTION",
                quantityDelta: delta,
                quantityBefore: expectedBaseline,
                quantityAfter: physicalQty,
                employeeId: ctx.employeeId,
                reason: "Inventura — korekcija na osnovu fizičkog prebrojavanja",
                referenceType: "INVENTORY_COUNT",
                referenceId: sessionId,
              },
            });
            correctionMovementId = mov.id;
          }
        }

        const newStatus = delta === 0 ? "MATCH" : delta < 0 ? "SHORTAGE" : "SURPLUS";
        await tx.inventoryCountLine.update({ where: { id: line.id }, data: { status: newStatus, correctionMovementId } });
      }
    });
  } catch (err) {
    if (err instanceof StaleLineError) {
      // Glavna transakcija je u potpunosti poništena (uključujući pokušaj
      // statusa CONFIRMED) — sesija ostaje OPEN. Samo OVAJ red se, u
      // posebnom pozivu, obeležava STALE da bi UI mogao da ga prikaže i
      // ponudi "Prebroj ponovo" / override.
      await prisma.inventoryCountLine.update({ where: { id: err.lineId }, data: { status: "STALE" } });
      const line = allLines.find((l) => l.id === err.lineId);
      const name =
        line?.targetType === "MENU_ITEM" ? (menuItemById.get(line.menuItemId!)?.name ?? "artikal") : "sirovina";
      throw new Error(
        `Stanje za "${name}" se promenilo tokom inventure (konkurentna prodaja/prijem) — potrebno je ponovno prebrojavanje ("Prebroj ponovo") ili odobrenje Vlasnika/Administratora.`
      );
    }
    throw err;
  }

  await recordAuditEntry(ctx, {
    entityType: "InventoryCountSession",
    entityId: sessionId,
    action: "inventory_count.confirmed",
    newValue: { linesCounted: countedLines.length, locationId: session.locationId, overrideCount: overrideSet.size },
    locationId: session.locationId,
  });

  return getSession(ctx, sessionId);
}
