import { NextResponse } from "next/server";
import { inventura } from "@rcs/domain";
import { confirmInventoryCountSessionSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json().catch(() => ({}));
  const input = confirmInventoryCountSessionSchema.parse(body);
  const session = await inventura.confirmSession(ctx, id, input);
  return NextResponse.json({ session });
});
