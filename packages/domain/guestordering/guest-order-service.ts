/**
 * P0 GUEST QR ORDERING.
 *
 * CANONICAL FLOW (spec): public menu -> guest LOCAL draft (client-only,
 * never reaches this module) -> finalizeGuestOrder (server snapshot) ->
 * opaque QR token -> waiter selects table -> reviewGuestOrderHandoff (scan,
 * read-only) -> claimGuestOrderHandoff (confirmed "DODAJ NA STO", atomic) ->
 * waiter's browser drives the EXISTING Instant Local Draft
 * (apps/web/lib/waiter-local-draft.ts / order-client.tsx addItemWithModifiers)
 * for each returned line -> EXISTING Send Order (order-service.ts
 * submitOrder) is the ONLY path that ever creates/dispatches real
 * Order/OrderItem/KDS/PrintJob/inventory-deduction activity.
 *
 * THIS MODULE NEVER TOUCHES Order, OrderItem, OrderItemStation, PrintJob,
 * Payment, InventoryMovement, or IngredientMovement — it only ever reads
 * MenuItem/RestaurantTable and writes GuestOrderHandoff/GuestOrderHandoffItem.
 * A guest can therefore never reach KDS/printing/payment/inventory through
 * this module by any input, by construction (see tests/integration/
 * guest-order-service.test.ts "no side effects" suite).
 *
 * SECURITY:
 *  - finalizeGuestOrder is the ONLY public (no AuthContext) function here —
 *    it never trusts client-supplied name/price/preparationStation, always
 *    re-reading authoritative MenuItem rows scoped to the resolved
 *    restaurant (never a client-supplied restaurantId).
 *  - The QR token is 256 bits of randomness (randomBytes(32)), lives ONLY
 *    in the returned payload / the QR image itself — this module persists
 *    only its SHA-256 hash (tokenHash), so a DB read/leak alone can never
 *    yield a usable token. Deliberately NOT reusing RestaurantTable.
 *    publicQrToken's plaintext convention — see schema.prisma doc comment
 *    on GuestOrderHandoff for why.
 *  - reviewGuestOrderHandoff/claimGuestOrderHandoff both scope every lookup
 *    by `tokenHash AND restaurantId: ctx.restaurantId` — a token issued by
 *    restaurant A can never resolve anything when looked up under
 *    restaurant B's ctx (cross-tenant scan fails with the same generic
 *    "not found" as a token that never existed at all — no enumeration
 *    signal).
 *  - claimGuestOrderHandoff is a SINGLE conditional UPDATE (Postgres
 *    guarantees atomicity of an UPDATE...WHERE) — two concurrent claims can
 *    never both succeed. The WHERE clause additionally allows a no-op
 *    "re-claim by the SAME table" to succeed idempotently — this is the
 *    recovery path if a client loses the claim response after the server
 *    already committed it (spec: "claimed but disappeared" must never
 *    happen) — the waiter can simply re-scan/re-confirm from the same table
 *    and get the same snapshot back, never a duplicate.
 */
import { randomBytes, createHash } from "crypto";
import { prisma } from "@rcs/db";
import { requireLocationAccess, type AuthContext } from "@rcs/auth";
import { requireOrderOperator } from "../orders/order-access";
import { recordAuditEntry } from "../audit/audit-service";
import { cacheGet, cacheIncr, cacheSet } from "../cache/cache-client";
import type { FinalizeGuestOrderInput, ClaimGuestOrderHandoffInput } from "@rcs/shared";

// Additive to spec's suggested 2-4h range — comfortably covers one seated
// visit (starter through dessert) without becoming a stale-QR liability if
// a guest forgets to show it to the waiter promptly.
const HANDOFF_LIFETIME_HOURS = 3;

// Coarse, best-effort abuse guard on the one truly public write in this
// module. Fails OPEN (allows the request) if Redis is unconfigured/erroring
// — same philosophy as every other cache-client.ts caller: PostgreSQL is
// the only thing that must never be unavailable; this is advisory, not the
// primary security boundary (token entropy + expiry + tenant scoping are).
const RATE_LIMIT_WINDOW_SECONDS = 600; // 10 minutes
const RATE_LIMIT_MAX_PER_WINDOW = 8;

export class GuestOrderValidationError extends Error {
  constructor(
    message: string,
    public readonly unavailableItemIds: string[] = []
  ) {
    super(message);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function checkFinalizeRateLimit(bucketKey: string): Promise<boolean> {
  const windowBucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `${bucketKey}:${windowBucket}`;
  const count = await cacheIncr(key);
  if (count === null) return true; // Redis unconfigured/erroring — fail open
  if (count === 1) {
    // First hit in this window is what sets the TTL. A second request
    // racing between this incr and this set could theoretically also try
    // to set it — harmless (same key, same intended TTL, worst case a
    // slightly-extended window), not worth a second round trip to avoid.
    await cacheSet(key, count, RATE_LIMIT_WINDOW_SECONDS);
  }
  return count <= RATE_LIMIT_MAX_PER_WINDOW;
}

export interface GuestOrderSnapshotItem {
  menuItemId: string;
  name: string;
  price: string;
  quantity: number;
  note: string | null;
  preparationStation: "KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE";
}
export interface GuestOrderSnapshot {
  itemCount: number;
  totalPrice: string;
  items: GuestOrderSnapshotItem[];
}
export interface FinalizeGuestOrderResult extends GuestOrderSnapshot {
  token: string;
  expiresAt: string;
}

/**
 * PUBLIC — no AuthContext. Called only from the public finalize API route.
 * Re-reads authoritative MenuItem data; never trusts client-supplied name/
 * price/station. Throws GuestOrderValidationError (never creates a handoff)
 * if any submitted item is unknown/inactive/unavailable for this
 * restaurant — `unavailableItemIds` lets the guest UI point at exactly
 * which line(s) changed since the draft was built.
 */
export async function finalizeGuestOrder(input: FinalizeGuestOrderInput, clientIp: string | null): Promise<FinalizeGuestOrderResult> {
  const rateLimitOk = await checkFinalizeRateLimit(`rate-limit:guest-finalize:${clientIp ?? "unknown"}:${input.slug}`);
  if (!rateLimitOk) {
    throw new GuestOrderValidationError("Previše zahteva. Sačekajte trenutak i pokušajte ponovo.");
  }

  const restaurant = await prisma.restaurant.findFirst({ where: { slug: input.slug, status: "ACTIVE" }, select: { id: true } });
  if (!restaurant) throw new GuestOrderValidationError("Restoran nije pronađen.");

  const qrSettings = await prisma.qrMenuSettings.findUnique({ where: { restaurantId: restaurant.id }, select: { isPublished: true } });
  if (qrSettings && !qrSettings.isPublished) throw new GuestOrderValidationError("Restoran nije pronađen.");

  const menuItemIds = [...new Set(input.items.map((i) => i.menuItemId))];
  const authoritativeItems = await prisma.menuItem.findMany({
    where: { id: { in: menuItemIds }, restaurantId: restaurant.id, isActive: true },
    select: { id: true, name: true, price: true, isAvailable: true, preparationStation: true },
  });
  const byId = new Map(authoritativeItems.map((item) => [item.id, item]));

  const unavailableItemIds = input.items.filter((i) => !byId.get(i.menuItemId)?.isAvailable).map((i) => i.menuItemId);
  if (unavailableItemIds.length > 0) {
    throw new GuestOrderValidationError("Neke stavke više nisu dostupne — ažurirajte porudžbinu.", [...new Set(unavailableItemIds)]);
  }

  const snapshotItems: GuestOrderSnapshotItem[] = input.items.map((i) => {
    const menuItem = byId.get(i.menuItemId)!; // presence guaranteed — unavailable/missing already rejected above
    return {
      menuItemId: menuItem.id,
      name: menuItem.name,
      price: menuItem.price.toString(),
      quantity: i.quantity,
      note: i.note?.trim() || null,
      preparationStation: menuItem.preparationStation,
    };
  });
  const itemCount = snapshotItems.reduce((sum, i) => sum + i.quantity, 0);
  const totalPrice = snapshotItems.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + HANDOFF_LIFETIME_HOURS * 60 * 60 * 1000);

  await prisma.guestOrderHandoff.create({
    data: {
      restaurantId: restaurant.id,
      tokenHash,
      itemCount,
      totalPrice: totalPrice.toFixed(2),
      expiresAt,
      items: {
        create: snapshotItems.map((i, index) => ({
          menuItemId: i.menuItemId,
          nameSnapshot: i.name,
          priceSnapshot: i.price,
          preparationStation: i.preparationStation,
          quantity: i.quantity,
          note: i.note,
          sortOrder: index,
        })),
      },
    },
  });

  return { token, expiresAt: expiresAt.toISOString(), itemCount, totalPrice: totalPrice.toFixed(2), items: snapshotItems };
}

function toSnapshot(handoff: { itemCount: number; totalPrice: unknown; items: Array<{ menuItemId: string; nameSnapshot: string; priceSnapshot: unknown; quantity: number; note: string | null; preparationStation: string }> }): GuestOrderSnapshot {
  return {
    itemCount: handoff.itemCount,
    totalPrice: handoff.totalPrice!.toString(),
    items: handoff.items
      .slice()
      .map((i) => ({
        menuItemId: i.menuItemId,
        name: i.nameSnapshot,
        price: i.priceSnapshot!.toString(),
        quantity: i.quantity,
        note: i.note,
        preparationStation: i.preparationStation as GuestOrderSnapshotItem["preparationStation"],
      })),
  };
}

/**
 * WAITER, read-only — "SCAN ≠ CLAIM" (spec). Never mutates status. Safe to
 * call repeatedly (e.g. re-opening the review sheet), including by multiple
 * waiters simultaneously eyeballing the same QR — only claimGuestOrderHandoff
 * below actually consumes it.
 */
export async function reviewGuestOrderHandoff(ctx: AuthContext, token: string): Promise<GuestOrderSnapshot> {
  requireOrderOperator(ctx);
  const tokenHash = hashToken(token);
  const handoff = await prisma.guestOrderHandoff.findFirst({
    where: { tokenHash, restaurantId: ctx.restaurantId },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
  if (!handoff) throw new Error("Porudžbina nije pronađena.");
  if (handoff.status === "CLAIMED") throw new Error("Ova porudžbina je već preuzeta.");
  if (handoff.status === "EXPIRED" || handoff.expiresAt.getTime() <= Date.now()) throw new Error("Ova porudžbina je istekla. Kreirajte novu.");
  return toSnapshot(handoff);
}

/**
 * WAITER — the ONLY function in this module that mutates GuestOrderHandoff
 * status. A single conditional UPDATE (atomic at the Postgres row level):
 * either this handoff is still PENDING and unexpired, or it was already
 * claimed by THIS EXACT table (idempotent recovery — see module doc
 * comment). Any other case (not found, expired, claimed by a different
 * table) updates zero rows, and the follow-up read picks the precise
 * guest-facing error.
 */
export async function claimGuestOrderHandoff(ctx: AuthContext, input: ClaimGuestOrderHandoffInput): Promise<GuestOrderSnapshot> {
  requireOrderOperator(ctx);

  const table = await prisma.restaurantTable.findFirst({
    where: { id: input.tableId, floor: { restaurantId: ctx.restaurantId } },
    select: { id: true, floor: { select: { locationId: true } } },
  });
  if (!table) throw new Error("Sto nije pronađen.");
  requireLocationAccess(ctx, table.floor.locationId);

  const tokenHash = hashToken(input.token);
  const now = new Date();
  const claim = await prisma.guestOrderHandoff.updateMany({
    where: {
      tokenHash,
      restaurantId: ctx.restaurantId,
      OR: [
        { status: "PENDING", expiresAt: { gt: now } },
        { status: "CLAIMED", claimedTableId: input.tableId },
      ],
    },
    data: { status: "CLAIMED", claimedAt: now, claimedByEmployeeId: ctx.employeeId, claimedTableId: input.tableId },
  });

  if (claim.count === 0) {
    const existing = await prisma.guestOrderHandoff.findFirst({ where: { tokenHash, restaurantId: ctx.restaurantId }, select: { status: true, expiresAt: true } });
    if (!existing) throw new Error("Porudžbina nije pronađena.");
    if (existing.status === "CLAIMED") throw new Error("Ova porudžbina je već preuzeta.");
    throw new Error("Ova porudžbina je istekla. Kreirajte novu.");
  }

  const handoff = await prisma.guestOrderHandoff.findFirstOrThrow({
    where: { tokenHash, restaurantId: ctx.restaurantId },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });

  await recordAuditEntry(ctx, {
    entityType: "GuestOrderHandoff",
    entityId: handoff.id,
    action: "guest_order_handoff.claimed",
    newValue: { itemCount: handoff.itemCount, totalPrice: handoff.totalPrice.toString(), tableId: input.tableId },
    locationId: table.floor.locationId,
    category: "qr_menu",
  });

  return toSnapshot(handoff);
}
