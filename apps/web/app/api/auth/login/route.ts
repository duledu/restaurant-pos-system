import { NextResponse } from "next/server";
import { prisma } from "@rcs/db";
import { verifyPassword, normalizeEmail, createSessionToken, sessionCookieOptions, type AuthContext } from "@rcs/auth";
import { loginSchema, resolveRedirectPath } from "@rcs/shared";
import { audit } from "@rcs/domain";

/**
 * Namerno vraća istu generičku poruku za "nema naloga" i "pogrešna lozinka"
 * — sprečava enumeraciju validnih email adresa.
 */
const GENERIC_ERROR = "Neispravan email ili lozinka";

export async function POST(request: Request) {
  // Ruta radi PRE nego što auth kontekst postoji, pa ne može koristiti
  // withApiAuth (apps/web/lib/api-helpers.ts) — zato ovde ručno hvatamo SVAKI
  // neočekivan izuzetak (npr. baza nedostupna) da odgovor klijentu UVEK bude
  // validan JSON, nikad prazno/ne-JSON telo (isti ugovor kao ostale API rute).
  try {
    const body = await request.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Neispravan zahtev" }, { status: 400 });
    }

    const email = normalizeEmail(parsed.data.email);
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        employee: {
          include: { roles: { include: { role: true } } },
        },
      },
    });

    if (!user || !user.isActive || !user.passwordHash || !user.employee) {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    const passwordOk = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!passwordOk) {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    if (user.employee.status !== "ACTIVE") {
      return NextResponse.json({ error: "Nalog zaposlenog nije aktivan" }, { status: 403 });
    }

    const token = await createSessionToken({
      userId: user.id,
      employeeId: user.employee.id,
      restaurantId: user.employee.restaurantId,
    });

    const minimalCtx: AuthContext = {
      userId: user.id,
      employeeId: user.employee.id,
      restaurantId: user.employee.restaurantId,
      locationIds: [],
      roles: [],
      permissions: new Set(),
    };
    await audit.recordAuditEntry(minimalCtx, {
      entityType: "Employee",
      entityId: user.employee.id,
      action: "auth.login",
    });

    const roleNames = user.employee.roles.map((er) => er.role.name);
    const redirectTo = resolveRedirectPath(roleNames);

    const response = NextResponse.json({ ok: true, redirectTo });
    response.cookies.set(sessionCookieOptions.name, token, sessionCookieOptions);
    return response;
  } catch (error) {
    console.error("POST /api/auth/login", error);
    return NextResponse.json({ error: "Prijava trenutno nije moguća — pokušaj ponovo" }, { status: 500 });
  }
}
