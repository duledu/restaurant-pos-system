import { NextResponse } from "next/server";
import { prisma } from "@rcs/db";

/**
 * Javna ruta — bez requireAuth — poziva se PRE sesije (iz /login i
 * device-setup na mount-u) da bi se verifikovalo da li deviceId iz
 * localStorage-a i dalje postoji kao aktivan uređaj u bazi. Vraća SAMO
 * boolean — nema podataka o zaposlenima ni restoranima.
 *
 * Bezbednost: deviceId je UUID (128-bitni prostor), ne tajni token —
 * ista informacija se već otkriva kroz /api/auth/staff-directory (403 ako
 * nije registrovan). Endpoint samo konsoliduje tu proveru u jednu, namensku
 * rutu bez bočnih efekata.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId");
  if (!deviceId) {
    return NextResponse.json({ registered: false });
  }
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { isActive: true },
  });
  return NextResponse.json({ registered: Boolean(device?.isActive) });
}
