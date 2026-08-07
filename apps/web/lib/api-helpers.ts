import { NextResponse } from "next/server";
import { requireAuth, UnauthorizedError, ForbiddenError, type AuthContext } from "@rcs/auth";

/**
 * Obavija route handler sa requireAuth() i mapira poznate greške na tačne
 * HTTP statuse. Svaka /api/admin/** ruta MORA koristiti ovaj wrapper (ili
 * direktno requireAuth) — ovo je mehanički način da se spreči da neko doda
 * novu rutu i zaboravi autorizaciju.
 */
export function withApiAuth<T>(
  handler: (ctx: AuthContext, request: Request, params: T) => Promise<Response>
) {
  return async (request: Request, context: { params: Promise<T> } | { params: T }) => {
    try {
      const ctx = await requireAuth(request);
      const params = await Promise.resolve(
        "params" in context ? (context.params as T | Promise<T>) : ({} as T)
      );
      return await handler(ctx, request, params);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return NextResponse.json({ error: error.message }, { status: 401 });
      }
      if (error instanceof ForbiddenError) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      const message = error instanceof Error ? error.message : "Neočekivana greška";
      // Poslovne greške (npr. "Kategorija nije pronađena") su bezbedne za
      // prikaz korisniku; ne otkrivaju interne detalje.
      return NextResponse.json({ error: message }, { status: 400 });
    }
  };
}
