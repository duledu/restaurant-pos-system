import { NextResponse } from "next/server";
import { guestOrdering } from "@rcs/domain";
import { guestOrderTokenSchema } from "@rcs/shared";

/**
 * PUBLIC, unauthenticated — see middleware.ts PUBLIC_API_PATHS. Read-only
 * status check the guest's QR-ready screen polls while visible (Phase 2
 * claim lifecycle). Never touches GuestOrderHandoff status itself.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = guestOrderTokenSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Neispravan zahtev" }, { status: 400 });
  }
  const status = await guestOrdering.checkGuestOrderHandoffStatus(parsed.data.token);
  return NextResponse.json({ status });
}
