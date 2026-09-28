import { NextResponse } from "next/server";
import { media } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";
import { readUploadedFile } from "../../../../../../lib/read-upload";

export const POST = withApiAuth<{ itemId: string }>(async (ctx, request, { itemId }) => {
  const upload = await readUploadedFile(request);
  const url = await media.uploadMenuItemImage(ctx, itemId, upload);
  return NextResponse.json({ imageUrl: url });
});

export const DELETE = withApiAuth<{ itemId: string }>(async (ctx, _request, { itemId }) => {
  await media.removeMenuItemImage(ctx, itemId);
  return NextResponse.json({ ok: true });
});
