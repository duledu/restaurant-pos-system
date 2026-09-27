import { NextResponse } from "next/server";
import { qrMenu } from "@rcs/domain";
import { updateQrMenuSettingsSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const settings = await qrMenu.getQrMenuSettings(ctx);
  return NextResponse.json({ settings });
});

export const PATCH = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = updateQrMenuSettingsSchema.parse(body);
  const settings = await qrMenu.updateQrMenuSettings(ctx, input);
  return NextResponse.json({ settings });
});
