import { NextResponse } from "next/server";
import { devices } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const list = await devices.listDevices(ctx);
  return NextResponse.json({ devices: list });
});
