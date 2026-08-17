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
