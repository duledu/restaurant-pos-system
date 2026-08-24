import { NextResponse } from "next/server";
import { employees } from "@rcs/domain";
import { resetPinSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

// NAMERNO nema GET handlera — PIN-reveal sposobnost je uklonjena (vidi
// employee-service.ts). Admin sme SAMO da postavi/resetuje PIN, nikad da
// pročita trenutni. Ne dodavati GET ovde bez izričitog odobrenja.
export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = resetPinSchema.parse(body);
  await employees.resetEmployeePin(ctx, id, input.pin);
  return NextResponse.json({ ok: true });
});
