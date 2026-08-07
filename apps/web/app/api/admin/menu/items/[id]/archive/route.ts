import { NextResponse } from "next/server";
import { menu } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  const item = await menu.archiveMenuItem(ctx, id);
  return NextResponse.json({ item });
});
