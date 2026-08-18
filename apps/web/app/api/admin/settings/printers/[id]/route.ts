import { NextResponse } from "next/server";
import { settings } from "@rcs/domain";
import { withApiAuth } from "../../../../../../lib/api-helpers";

// Kreiranje/izmena ide isključivo kroz POST /api/admin/settings/printers
// (upsert po @@unique([locationId, station]) — vidi settings-service.ts).
// Ova ruta samo briše, izbegava dvosmislenost "PUT po id" naspram
// "upsert po (locationId, station)" prirodnog ključa.
export const DELETE = withApiAuth<{ id: string }>(async (ctx, _request, { id }) => {
  await settings.deletePrinterConfig(ctx, id);
  return NextResponse.json({ ok: true });
});
