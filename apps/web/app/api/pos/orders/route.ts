import { NextResponse } from "next/server";
import { orders } from "@rcs/domain";
import { openOrderSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const { tableId } = openOrderSchema.pick({ tableId: true }).parse({ tableId: new URL(request.url).searchParams.get("tableId") });
  return NextResponse.json(await orders.getActiveTableOrder(ctx, tableId), {
    headers: { "Cache-Control": "private, no-store" },
  });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = openOrderSchema.parse(body);
  const order = await orders.openOrder(ctx, input);
  return NextResponse.json({ order }, { status: 201 });
});
