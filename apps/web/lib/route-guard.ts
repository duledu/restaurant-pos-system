import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAuth, UnauthorizedError, ForbiddenError, type AuthContext } from "@rcs/auth";

/**
 * Server-side guard za layout.tsx fajlove. Ovo je pored requireAuth() u
 * svakoj API ruti (defense in depth) — sprečava da neautentifikovan
 * korisnik, ili korisnik bez odgovarajuće role, uopšte vidi HTML stranice
 * pod ovom rutom, ČAK I ako ručno unese URL (zahtev specifikacije).
 */
export async function requireRouteAccess(allowedRoles: string[]): Promise<AuthContext> {
  const headersList = await headers();
  const fakeRequest = new Request("http://internal/", {
    headers: { cookie: headersList.get("cookie") ?? "" },
  });

  let ctx: AuthContext;
  try {
    ctx = await requireAuth(fakeRequest);
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      redirect("/login");
    }
    throw error;
  }

  const hasAccess = ctx.roles.some((r) => allowedRoles.includes(r));
  if (!hasAccess) {
    // Ne "Forbidden" ekran — tiho vraćamo na login, koji će ionako
    // preusmeriti na ispravnu rutu za tu rolu ako se ponovo prijavi.
    redirect("/login");
  }

  return ctx;
}
