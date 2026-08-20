import { NextResponse } from "next/server";
import { devices } from "@rcs/domain";

export const dynamic = "force-dynamic";

/**
 * Javna ruta (bez requireAuth — vidi middleware.ts PUBLIC_API_PATHS i
 * napomenu u device-service.ts listStaffForDevice): poziva se sa /login
 * ekrana PRE nego što bilo kakva sesija postoji. Opseg dolazi isključivo iz
 * deviceId-a (mora biti već registrovan uređaj), nikad iz restaurantId/
 * locationId parametara — zato ih ova ruta ni ne prihvata.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const deviceId = searchParams.get("deviceId");
    if (!deviceId) {
      return NextResponse.json({ error: "deviceId je obavezan" }, { status: 400 });
    }

    const staff = await devices.listStaffForDevice(deviceId);
    if (staff === null) {
      return NextResponse.json({ error: "Uređaj nije registrovan" }, { status: 403 });
    }
    return NextResponse.json({ staff });
  } catch (error) {
    console.error("GET /api/auth/staff-directory", error);
    return NextResponse.json({ error: "Trenutno nije moguće učitati listu osoblja" }, { status: 500 });
  }
}
