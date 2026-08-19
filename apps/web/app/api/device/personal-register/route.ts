import { NextResponse } from "next/server";
import { z } from "zod";
import { devices } from "@rcs/domain";

const schema = z.object({
  username: z.string().trim().min(1, "Korisničko ime je obavezno"),
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
    const isAuthError = message === "Neispravno korisničko ime ili lozinka";
    return NextResponse.json({ error: message }, { status: isAuthError ? 401 : 400 });
  }
}
