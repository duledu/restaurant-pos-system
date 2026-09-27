import { NextResponse } from "next/server";
import { qrMenu } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const token = await qrMenu.getOrCreateTableQrToken(ctx, id);
  return NextResponse.json({ token });
});
