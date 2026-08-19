import { NextResponse } from "next/server";
import { z } from "zod";
import { inventory } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

const schema = z.object({
  locationId: z.string().uuid(),
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = schema.parse(body);
  const result = await inventory.bulkZeroOpeningStock(ctx, input);
  return NextResponse.json(result);
});
