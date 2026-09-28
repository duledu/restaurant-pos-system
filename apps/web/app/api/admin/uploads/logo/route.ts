import { NextResponse } from "next/server";
import { media } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";
import { readUploadedFile } from "../../../../../lib/read-upload";

export const POST = withApiAuth(async (ctx, request) => {
  const upload = await readUploadedFile(request);
  const url = await media.uploadRestaurantLogo(ctx, upload);
  return NextResponse.json({ logoUrl: url });
});

export const DELETE = withApiAuth(async (ctx) => {
  await media.removeRestaurantLogo(ctx);
  return NextResponse.json({ ok: true });
});
