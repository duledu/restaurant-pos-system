import { NextResponse } from "next/server";
import { z } from "zod";
import { tables } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

const updateFloorSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updateFloorSchema.parse(body);
  const floor = await tables.updateFloor(ctx, id, input);
  return NextResponse.json({ floor });
});
