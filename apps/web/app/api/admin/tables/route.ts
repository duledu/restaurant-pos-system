import { NextResponse } from "next/server";
import { z } from "zod";
import { tables } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

const createTableSchema = z.object({
  floorId: z.string().uuid(),
  label: z.string().trim().min(1).max(40),
  capacity: z.number().int().min(1).max(999).optional(),
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createTableSchema.parse(body);
  const table = await tables.createTable(ctx, input);
  return NextResponse.json({ table }, { status: 201 });
});
