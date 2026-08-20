import { NextResponse } from "next/server";
import { z } from "zod";
import { tables } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("locationId");
  if (!locationId) return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  const floors = await tables.adminListFloors(ctx, locationId);
  return NextResponse.json({ floors });
});

const createFloorSchema = z.object({
  locationId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = createFloorSchema.parse(body);
  const floor = await tables.createFloor(ctx, input);
  return NextResponse.json({ floor }, { status: 201 });
});
