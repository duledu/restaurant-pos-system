import { NextResponse } from "next/server";
import { menu } from "@rcs/domain";
import { createMenuItemSchema, menuItemFiltersSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const filters = menuItemFiltersSchema.parse({
    search: url.searchParams.get("search") ?? undefined,
    categoryId: url.searchParams.get("categoryId") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    preparationStation: url.searchParams.get("station") ?? undefined,
    activeOnly: url.searchParams.get("activeOnly") === "true" ? true : undefined,
    locationId: url.searchParams.get("locationId") ?? undefined,
  });
  const items = await menu.listMenuItems(ctx, filters);
  return NextResponse.json({ items });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createMenuItemSchema.parse(body);
  const item = await menu.createMenuItem(ctx, input);
  return NextResponse.json({ item }, { status: 201 });
});
