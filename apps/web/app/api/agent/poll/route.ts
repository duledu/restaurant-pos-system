import { NextResponse } from "next/server";
import { agentPrinting, workstations } from "@rcs/domain";
import { withWorkstationAuth } from "../../../../lib/api-helpers";

/**
 * Autentifikovan preko Authorization: Bearer (withWorkstationAuth) —
 * restoran/lokacija/stanica se izvode ISKLJUČIVO iz kredencijala, telo
 * zahteva je prazno. Vraća `{job: null}` (200) kad nema ništa čekajuće —
 * NIKAD grešku za "prazan poll", agent to tumači kao normalan ishod i
 * nastavlja polling po sopstvenom rasporedu.
 *
 * `testPrintRequested` — dodato uz `job` (ne menja pollAndClaim ni njegov
 * povratni tip) da bi Admin "Test Print" dugme koristilo ISTI brz poll
 * ciklus (1-3s) kao stvarni tiketi, umesto da čeka do 25s heartbeat-a
 * (dokazan uzrok ~19s kašnjenja). Heartbeat i dalje nezavisno nosi isti
 * signal (workstations.recordHeartbeat) — namerno neizmenjeno, ovo je
 * dodatan, brži put do ISTOG servera-strane stanja, ne zamena.
 */
export const POST = withWorkstationAuth(async (wsCtx) => {
  const [job, testPrintRequested] = await Promise.all([
    agentPrinting.pollAndClaim(wsCtx),
    workstations.isTestPrintPending(wsCtx),
  ]);
  return NextResponse.json({ job, testPrintRequested });
});
