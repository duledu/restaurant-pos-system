import { NextResponse } from "next/server";
import { z } from "zod";
import { devices } from "@rcs/domain";

// Ova ruta se poziva PRE autentifikacije — zaposleni se identifikuje
// email+lozinkom (postavljenim od strane admina), bez aktivne sesije.
// Ne koristi withApiAuth jer nema sesiju u ovom trenutku.

const schema = z.object({
  email: z.string().trim().toLowerCase().email("Neispravna email adresa"),
  password: z.string().min(1, "Lozinka je obavezna"),
});

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Neispravan zahtev" }, { status: 400 });
    }

    const result = await devices.registerPersonalDevice(parsed.data);
    return NextResponse.json({ deviceId: result.deviceId, employeeName: result.employeeName }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Registracija nije uspela";
    // Prikazujemo genericku poruku za auth greške, ali detaljnu za ostale
    const isAuthError = message === "Neispravan email ili lozinka";
    return NextResponse.json({ error: message }, { status: isAuthError ? 401 : 400 });
  }
}
