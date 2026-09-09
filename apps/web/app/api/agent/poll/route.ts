import { NextResponse } from "next/server";
import { agentPrinting } from "@rcs/domain";
import { withWorkstationAuth } from "../../../../lib/api-helpers";

/**
 * Autentifikovan preko Authorization: Bearer (withWorkstationAuth) —
 * restoran/lokacija/stanica se izvode ISKLJUČIVO iz kredencijala, telo
 * zahteva je prazno. Vraća `{job: null}` (200) kad nema ništa čekajuće —
 * NIKAD grešku za "prazan poll", agent to tumači kao normalan ishod i
 * nastavlja polling po sopstvenom rasporedu.
 */
export const POST = withWorkstationAuth(async (wsCtx) => {
  const job = await agentPrinting.pollAndClaim(wsCtx);
  return NextResponse.json({ job });
});
