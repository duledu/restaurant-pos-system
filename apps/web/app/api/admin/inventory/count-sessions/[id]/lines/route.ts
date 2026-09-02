import { NextResponse } from "next/server";
import { inventura } from "@rcs/domain";
import { addInventoryCountLinesSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = addInventoryCountLinesSchema.parse(body);
  const lineIds = await inventura.addLines(ctx, id, input);
  return NextResponse.json({ lineIds }, { status: 201 });
});
