import { NextResponse } from "next/server";
import { inventura } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const GET = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const session = await inventura.getSession(ctx, id);
  return NextResponse.json({ session });
});
