import { NextResponse } from "next/server";
import { workstations } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

// PRINTING V2 FINAL — Admin restaurant-level printing mode (REŽIM ŠTAMPE).
export const GET = withApiAuth(async (ctx) => {
  const printingMode = await workstations.getPrintingMode(ctx);
  return NextResponse.json({ printingMode });
});

export const PUT = withApiAuth(async (ctx, request) => {
  const body = await request.json();
  const result = await workstations.setPrintingMode(ctx, body);
  return NextResponse.json(result);
});
