import { NextResponse } from "next/server";
import { devices } from "@rcs/domain";
import { setDeviceStatusSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../../lib/api-helpers";

export const POST = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = setDeviceStatusSchema.parse(body);
  const device = input.isActive
    ? await devices.reactivateDevice(ctx, id)
    : await devices.revokeDevice(ctx, id);
  return NextResponse.json({ device });
});
