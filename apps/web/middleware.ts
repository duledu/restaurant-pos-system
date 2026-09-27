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

// BRANDED QR MENU V1 — /m/{slug} (and its query-string table variant,
// /m/{slug}?t={token}) is the guest-facing public menu: no login, no PIN,
// no active shift (spec section 9). Prefix (not an exact path) because the
// slug is a dynamic segment — same reasoning as PUBLIC_API_PREFIXES below.
// This route touches NO session/employee data; its own server-side handler
// (qr-menu-service.ts getPublicMenu) is what actually resolves and scopes
// the restaurant, never this Edge-runtime check.
const PUBLIC_PAGE_PREFIXES = ["/m/"];
const PUBLIC_API_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/pin-login",
  "/api/auth/staff-directory",
  "/api/device/personal-register",
  "/api/device/check",
]);

// Faza 2A/2B — TableCore Print Agent: SVAKA /api/agent/** ruta autentifikuje
// preko Authorization: Bearer <kredencijal radne stanice>
// (withWorkstationAuth, packages/auth/workstation-auth.ts) ili (register)
// preko jednokratnog koda za uparivanje — NIKAD preko rcs_session cookie-ja,
// pa bi ih ovaj middleware inače blokirao PRE nego što handler uopšte
// stigne da proveri sopstvenu autentifikaciju. "Javno" ovde znači samo
// "izuzeto od cookie provere", ne "bez autentifikacije" — isti princip kao
// /api/device/personal-register (nema cookie, ali zahteva lozinku). Prefiks
// (ne lista tačnih putanja) namerno — /api/agent/jobs/[jobId]/start i
// .../result imaju dinamički segment, a SVAKA buduća /api/agent/** ruta
// deli isto pravilo, pa nema smisla nabrajati svaku posebno.
const PUBLIC_API_PREFIXES = ["/api/agent/"];

function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PAGE_PATHS.has(pathname) ||
    PUBLIC_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    PUBLIC_API_PATHS.has(pathname) ||
    PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
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
  // Poklapa sve rute OSIM Next.js internih asset-a (_next/static, _next/image),
  // favicon.ico, public/branding/** i (P3.1) manifest.webmanifest + public/icons/**
  // — sve ovo mora biti čitljivo NEautentifikovanom browseru (npr. Chrome
  // proverava manifest/ikone PRE bilo kakve prijave da bi ponudio instalaciju
  // na /login ekranu). Ovo su isključivo statični PWA/branding asset-i, bez
  // ikakvog restoranskog/poslovnog podatka — ista logika kao postojeći
  // branding/ izuzetak iznad. Sve ostalo (stranice i /api/**) i dalje prolazi
  // kroz gornju proveru.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|branding/|icons/|manifest.webmanifest).*)"],
};
