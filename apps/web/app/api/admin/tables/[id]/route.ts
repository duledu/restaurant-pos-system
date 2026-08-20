import { NextResponse } from "next/server";
import { z } from "zod";
import { tables } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

const updateTableSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  capacity: z.number().int().min(1).max(999).optional(),
  floorId: z.string().uuid().optional(),
});

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = updateTableSchema.parse(body);
  const table = await tables.updateTable(ctx, id, input);
  return NextResponse.json({ table });
});
