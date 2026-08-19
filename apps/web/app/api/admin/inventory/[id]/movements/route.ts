import { NextResponse } from "next/server";
import { inventory } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10), 500);
  const movements = await inventory.getMovements(ctx, id, limit);
  return NextResponse.json({ movements });
});
