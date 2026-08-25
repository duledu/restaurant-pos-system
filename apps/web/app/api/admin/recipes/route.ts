import { NextResponse } from "next/server";
import { recipes } from "@rcs/domain";
import { withApiAuth } from "../../../../lib/api-helpers";

/**
 * Normativi overview — jedan red po MenuItem-u, koristi Admin → Normativi
 * listing stranicu (search/kategorija/status filteri rade na klijentu).
 */
export const GET = withApiAuth(async (ctx) => {
  const items = await recipes.listRecipeOverview(ctx);
  return NextResponse.json({ items });
});
