import { NextResponse } from "next/server";
import { prisma } from "@rcs/db";
import { verifyPassword, normalizeEmail, createSessionToken, sessionCookieOptions, loginThrottleKey, type AuthContext } from "@rcs/auth";
import { loginSchema, resolveRedirectPath } from "@rcs/shared";
import { audit } from "@rcs/domain";
import { clearLoginThrottle, getActiveLoginThrottle, recordFailedLogin } from "../../../../lib/login-throttle";

/**
 * Namerno vraća istu generičku poruku za "nema naloga" i "pogrešna lozinka"
 * — sprečava enumeraciju validnih email adresa.
 */
const GENERIC_ERROR = "Neispravan email ili lozinka";
const DUMMY_PASSWORD_HASH = `${"0".repeat(32)}:${"0".repeat(128)}`;

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
    const throttleKey = loginThrottleKey(email);
    const lockedUntil = await getActiveLoginThrottle(throttleKey);
    if (lockedUntil) {
      const retryAfter = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
      return NextResponse.json(
        { error: "Previše neuspešnih pokušaja. Pokušaj ponovo kasnije." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        employee: {
          include: {
            roles: { include: { role: true } },
            restaurant: { include: { tenant: true } },
          },
        },
      },
    });

    const passwordOk = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.passwordHash || !user.employee || !passwordOk) {
      const throttle = await recordFailedLogin(throttleKey);
      if (throttle.lockedUntil) {
        const retryAfter = Math.max(1, Math.ceil((throttle.lockedUntil.getTime() - Date.now()) / 1000));
        return NextResponse.json(
          { error: "Previše neuspešnih pokušaja. Pokušaj ponovo kasnije." },
          { status: 429, headers: { "Retry-After": String(retryAfter) } }
        );
      }
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    if (!user.isActive || user.employee.status !== "ACTIVE") {
      return NextResponse.json({ error: "Nalog zaposlenog nije aktivan" }, { status: 403 });
    }
    if (user.employee.restaurant.status !== "ACTIVE" || user.employee.restaurant.tenant.status !== "ACTIVE") {
      return NextResponse.json({ error: "Restoran nije aktivan" }, { status: 403 });
    }

    await clearLoginThrottle(throttleKey);

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
