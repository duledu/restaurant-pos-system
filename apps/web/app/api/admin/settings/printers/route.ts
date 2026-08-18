import { NextResponse } from "next/server";
import { settings } from "@rcs/domain";
import { printerConfigSchema } from "@rcs/shared";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx, request) => {
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  if (!locationId) {
    return NextResponse.json({ error: "locationId je obavezan" }, { status: 400 });
  }
  const printers = await settings.listPrinterConfigs(ctx, locationId);
  return NextResponse.json({ printers });
});

export const POST = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const input = printerConfigSchema.parse(body);
  const printer = await settings.upsertPrinterConfig(ctx, input);
  return NextResponse.json({ printer }, { status: 201 });
});
