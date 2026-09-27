import { NextResponse } from "next/server";
import { qrMenu } from "@rcs/domain";
import { withApiAuth } from "../../../../../lib/api-helpers";

export const GET = withApiAuth(async (ctx) => {
  const floors = await qrMenu.listTablesForQr(ctx);
  return NextResponse.json({ floors });
});
