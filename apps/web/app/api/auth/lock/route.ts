import { NextResponse } from "next/server";
import { requireAuth, sessionCookieOptions } from "@rcs/auth";
import { audit } from "@rcs/domain";

/**
 * Quick Lock — NIJE logout u poslovnom smislu (smena/porudžbine/stolovi
 * ostaju netaknuti, vidi packages/domain/*), ali je bezbednosno IDENTIČAN
 * mehanizmu odjave: sesija je bez-stanja potpisan JWT (session.ts) — jedini
 * bezbedan način da se prethodni zaposleni odmah ukloni sa terminala je da
 * se cookie obriše, isto kao /api/auth/logout. Nijedno poslovno stanje
 * (smena/porudžbina/sto/draft/KDS) nije vezano za sesiju — sve je vezano za
 * employeeId u bazi (requireDraftOwnership, getActiveShift, ...) — zato
 * brisanje cookie-ja ne dotiče ništa od toga.
 *
 * Ruta radi kao i logout/pin-login: nikad ne sme baciti neuhvaćen izuzetak,
 * uvek vraća validan JSON i UVEK briše cookie (cilj — "bez sesije" — je
 * bezbedan da se postigne čak i ako audit upis ili requireAuth ne uspeju).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth(request);
    await audit.recordAuditEntry(ctx, {
      entityType: "Employee",
      entityId: ctx.employeeId,
      action: "auth.terminal_locked",
    });
  } catch {
    // Nema validne sesije (npr. terminal je već zaključan) — nema šta da se
    // audituje, ali cilj (bez sesije) je već postignut. Nastavi na brisanje
    // cookie-ja ispod bez greške.
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookieOptions.name, "", {
    ...sessionCookieOptions,
    maxAge: 0,
    expires: new Date(0),
  });
  return response;
}
