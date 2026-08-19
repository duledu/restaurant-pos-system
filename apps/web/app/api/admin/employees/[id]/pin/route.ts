import { NextResponse } from "next/server";
import { employees } from "@rcs/domain";
import { resetPinSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = resetPinSchema.parse(body);
  await employees.resetEmployeePin(ctx, id, input.pin);
  return NextResponse.json({ ok: true });
});

/**
 * Otkriva PIN zaposlenog ovlašćenom adminu.
 * No-cache headers sprečavaju keš browsera/CDN-a da cuva otkriveni PIN.
 */
export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const pin = await employees.revealEmployeePin(ctx, id);
  const response = NextResponse.json({ pin });
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
});
