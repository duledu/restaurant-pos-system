import { NextResponse } from "next/server";
import { devices } from "@rcs/domain";
import { renameDeviceSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const PATCH = withApiAuth<{ id: string }>(async (ctx, request, { id }) => {
  const body = await request.json();
  const input = renameDeviceSchema.parse(body);
  const device = await devices.renameDevice(ctx, id, input.name);
  return NextResponse.json({ device });
});
