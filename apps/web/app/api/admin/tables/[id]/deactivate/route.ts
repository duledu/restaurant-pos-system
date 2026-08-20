import { NextResponse } from "next/server";
import { tables } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const table = await tables.deactivateTable(ctx, id);
  return NextResponse.json({ table });
});
