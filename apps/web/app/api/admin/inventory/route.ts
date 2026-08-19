import { NextResponse } from "next/server";
import { z } from "zod";
import { inventory } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("locationId") ?? undefined;
  const items = await inventory.listInventory(ctx, locationId);
  return NextResponse.json({ items });
});

const initSchema = z.object({
  menuItemId:   z.string().uuid(),
  locationId:   z.string().uuid(),
  initialStock: z.number().int().min(0),
  unit:         z.string().trim().max(20).optional(),
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = initSchema.parse(body);
  const item = await inventory.initializeTracking(ctx, input);
  return NextResponse.json({ item }, { status: 201 });
});
