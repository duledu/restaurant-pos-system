import { NextResponse } from "next/server";
import { devices } from "@rcs/domain";
import { registerDeviceSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../lib/api-helpers";

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = registerDeviceSchema.parse(body);
  const device = await devices.registerDevice(ctx, input);
  return NextResponse.json({ deviceId: device.id }, { status: 201 });
});
