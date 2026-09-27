import { NextResponse } from "next/server";
import { qrMenu } from "@rcs/domain";
import { updateRestaurantSlugSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const PATCH = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const { slug } = updateRestaurantSlugSchema.parse(body);
  const updated = await qrMenu.updateRestaurantSlug(ctx, slug);
  return NextResponse.json({ slug: updated });
});
