import { NextResponse } from "next/server";
import { z } from "zod";
import { menu } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

const bodySchema = z.object({ isAvailable: z.boolean() });

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const { isAvailable } = bodySchema.parse(body);
  const item = await menu.setAvailability(ctx, id, isAvailable);
  return NextResponse.json({ item });
});
