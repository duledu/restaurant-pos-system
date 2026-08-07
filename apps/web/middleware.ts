import { NextResponse, type NextRequest } from "next/server";
import { verifySessionToken, sessionCookieOptions } from "@rcs/auth/session";

/**
 * Globalni bezbednosni backstop (defense-in-depth), NE zamena za
 * requireRouteAccess() (layout.tsx) ili requireAuth()/withApiAuth (API rute).
 *
 * Ovaj middleware radi na Edge runtime-u pa NE SME dotaći Prisma/bazu —
 * zato proverava SAMO da li postoji validno potpisana, neistekla sesija
 * (autentifikacija). Role, permisije i location-scoping ostaju isključivo
 * odgovornost requireRouteAccess/requireAuth/domain servisa, koji rade sa
 * SVEŽIM podacima iz baze (vidi napomenu u rbac.ts zašto se role ne smeju
 * čitati iz JWT-a).
 *
 * Svrha: ako neko doda novu zaštićenu stranicu ili API rutu i ZABORAVI da
 * pozove requireRouteAccess/withApiAuth, ta ruta i dalje NEĆE biti javno
 * dostupna neautentifikovanom korisniku — default je "zahtevaj sesiju",
 * a javne rute se moraju eksplicitno navesti ispod.
 */
const PUBLIC_PAGE_PATHS = new Set(["/login"]);
const PUBLIC_API_PATHS = new Set(["/api/auth/login", "/api/auth/pin-login"]);

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PAGE_PATHS.has(pathname) || PUBLIC_API_PATHS.has(pathname);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(sessionCookieOptions.name)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Poklapa sve rute OSIM Next.js internih asset-a (_next/static, _next/image)
  // i favicon.ico — sve ostalo (stranice i /api/**) prolazi kroz gornju proveru.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
