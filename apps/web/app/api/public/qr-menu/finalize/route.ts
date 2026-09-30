import { NextResponse } from "next/server";
import { guestOrdering } from "@rcs/domain";
import { GuestOrderValidationError } from "@rcs/domain/guestordering/guest-order-service";
import { finalizeGuestOrderSchema } from "@rcs/shared";

/** Best-effort — same documented pattern/limits as apps/web/app/api/agent/register/route.ts's sourceIp. */
function sourceIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

const GENERIC_ERROR = "Porudžbinu trenutno nije moguće kreirati. Pokušajte ponovo.";

/**
 * PUBLIC, unauthenticated — the ONLY write path a guest can reach (see
 * middleware.ts PUBLIC_API_PATHS). Never creates an Order/OrderItem/KDS/
 * PrintJob/Payment/InventoryMovement — only a GuestOrderHandoff snapshot a
 * waiter must separately review and explicitly claim. See
 * packages/domain/guestordering/guest-order-service.ts module doc comment.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = finalizeGuestOrderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Neispravan zahtev" }, { status: 400 });
    }
    const result = await guestOrdering.finalizeGuestOrder(parsed.data, sourceIp(request));
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof GuestOrderValidationError) {
      return NextResponse.json({ error: error.message, unavailableItemIds: error.unavailableItemIds }, { status: 400 });
    }
    console.error("[guest-order-finalize]", error);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
