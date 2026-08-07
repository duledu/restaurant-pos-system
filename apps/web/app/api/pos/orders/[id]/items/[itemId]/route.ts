import { NextResponse } from "next/server";
import { orders } from "@rcs/domain";
import { updateOrderItemSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

export const PATCH = withApiAuth<{ id: string; itemId: string }>(async (ctx, request, { id, itemId }) => {
  const body = await request.json();
  const input = updateOrderItemSchema.parse(body);
  const item = await orders.updateItem(ctx, id, itemId, input);
  return NextResponse.json({ item });
});

export const DELETE = withApiAuth<{ id: string; itemId: string }>(async (ctx, _request, { id, itemId }) => {
  await orders.removeItem(ctx, id, itemId);
  return NextResponse.json({ ok: true });
});
