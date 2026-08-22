import { NextResponse } from "next/server";
import { modifiers } from "@rcs/domain";
import { withApiAuth } from "../../../../../../../../lib/api-helpers";

export const DELETE = withApiAuth<{ id: string; groupId: string }>(async (ctx, _request, { id, groupId }) => {
  await modifiers.detachModifierGroupFromItem(ctx, id, groupId);
  return NextResponse.json({ ok: true });
});
