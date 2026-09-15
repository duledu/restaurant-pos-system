/**
 * Faza 2B — TableCore Print Agent isporuka. NAMERNO ne uvodi novi
 * state-machine za PrintJob — u potpunosti PONOVO KORISTI
 * beginPrintAttempt/startPrintSubmission/confirmPrintResult iz
 * print-service.ts (nepromenjene, već dokazane na 69/69 combined
 * integration). Jedina nova stvar ovde je KAKO se do tih funkcija dolazi
 * kad pozivalac nije zaposleni nego autentifikovana radna stanica.
 *
 * `workstationAsPrintClaimant` gradi AuthContext-oblik iz
 * WorkstationAuthContext-a: `restaurantId`/`locationIds`/`roles` se
 * postavljaju TAČNO iz autentifikovanog identiteta radne stanice (nikad iz
 * bilo čega što agent tvrdi u telu zahteva), pa postojeće provere
 * (scopeToRestaurant, requireLocationAccess, assertStationAccess) VEĆ
 * ispravno ograničavaju agenta na sopstveni restoran/lokaciju/stanicu —
 * bez ijedne nove provere. `claimedBy` postaje `workstation:<id>`, jasno
 * razlučivo od pravog employeeId-a (uvek UUID bez prefiksa) u audit
 * tragu/DB redu.
 */
import { prisma } from "@rcs/db";
import type { AuthContext, WorkstationAuthContext, WorkstationStationValue } from "@rcs/auth";
import { beginPrintAttempt, startPrintSubmission, confirmPrintResult, STALE_PRINT_LEASE_MS } from "./print-service";
import { activeWorkstationFor, AGENT_ACTIVE_WINDOW_MS } from "./print-policy";

function workstationAsPrintClaimant(wsCtx: WorkstationAuthContext): AuthContext {
  const claimantId = `workstation:${wsCtx.workstationId}`;
  return {
    userId: claimantId,
    employeeId: claimantId,
    restaurantId: wsCtx.restaurantId,
    locationIds: [wsCtx.locationId],
    roles: [wsCtx.station],
    permissions: new Set(["orders.print", "production.manage"]),
  };
}

export interface AgentTicketPayload {
  jobId: string;
  attemptId: string;
  station: WorkstationStationValue;
  documentType: string;
  isReprint: boolean;
  attemptCount: number;
  content: unknown;
}

/**
 * Nalazi i ATOMSKI kandiduje SLEDEĆI čekajući automatski tiket za TAČNO
 * restoran/lokaciju/stanicu autentifikovane radne stanice, pa ga odmah
 * kandiduje preko beginPrintAttempt (nepromenjeno). Vraća `null` ako nema
 * ništa ILI ako je izgubljena trka za kandidata (druga radna stanica ILI
 * KDS/QZ browser put ga je uzeo u međuvremenu) — oba slučaja su normalna,
 * ne greška; pozivalac (agent) samo pokušava ponovo na sledećem poll-u.
 *
 * Sopstveni "stale recovery" prolaz (isti prag/logika kao
 * listPendingStationPrintJobs) je OBAVEZAN ovde — agent može biti JEDINI
 * potrošač ove stanice (KDS tab može biti zatvoren), pa niko drugi možda
 * nikad ne pokrene taj prolaz za redove van trenutnog kandidata.
 */
export async function pollAndClaim(wsCtx: WorkstationAuthContext): Promise<AgentTicketPayload | null> {
  const { restaurantId, locationId, station } = wsCtx;
  const staleThreshold = new Date(Date.now() - STALE_PRINT_LEASE_MS);

  await prisma.printJob.updateMany({
    where: {
      restaurantId,
      locationId,
      station,
      status: "PRINTING",
      attemptId: { not: null },
      submissionStartedAt: null,
      claimedAt: { lt: staleThreshold },
    },
    data: { status: "PENDING", attemptId: null, claimedBy: null, claimedAt: null },
  });
  await prisma.printJob.updateMany({
    where: { restaurantId, locationId, station, status: "PRINTING", submissionStartedAt: { lt: staleThreshold } },
    data: { status: "SUBMISSION_UNKNOWN", failureReason: "Potvrda štampe nedostaje; proverite štampač pre novog otiska." },
  });

  // isAutomatic:true — namerno: ručna štampa/reprint ostaju NEZAVISNI od
  // agent poll-a u ovoj fazi (zahtev specifikacije "Do NOT over-expand
  // scope"). status:"PENDING" nikad uključuje SUPPRESSED (drugačija
  // vrednost enuma) — poll endpoint stoga strukturno nikad ne vraća
  // suzbijene automatske redove.
  const candidate = await prisma.printJob.findFirst({
    where: { restaurantId, locationId, station, status: "PENDING", isAutomatic: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, orderId: true },
  });
  if (!candidate) return null;

  const claimantCtx = workstationAsPrintClaimant(wsCtx);
  const claimed = await beginPrintAttempt(claimantCtx, candidate.orderId, candidate.id);
  if (!claimed || !claimed.attemptId || !claimed.station) return null;

  return {
    jobId: claimed.id,
    attemptId: claimed.attemptId,
    station: claimed.station,
    documentType: claimed.type,
    isReprint: claimed.isReprint,
    attemptCount: claimed.attemptCount,
    content: claimed.content,
  };
}

/** "I am about to begin the external side effect" — mora prethoditi
 * PrintDocument.Print pozivu na agentu. Ponovo koristi
 * startPrintSubmission nepromenjeno. */
export async function beginSubmission(wsCtx: WorkstationAuthContext, jobId: string, attemptId: string) {
  const job = await prisma.printJob.findFirst({
    where: { id: jobId, restaurantId: wsCtx.restaurantId, locationId: wsCtx.locationId, station: wsCtx.station },
    select: { orderId: true },
  });
  if (!job) throw new Error("Print job nije pronađen");
  return startPrintSubmission(workstationAsPrintClaimant(wsCtx), job.orderId, jobId, attemptId);
}

export type AgentResultOutcome = "SUBMITTED_TO_SPOOLER" | "FAILED_BEFORE_SUBMISSION" | "SUBMISSION_UNKNOWN";

/** Ponovo koristi confirmPrintResult nepromenjeno — isto polje
 * `resultOutcome` prihvata i TRANSPORT_COMPLETED (browser put), ovde se
 * agentu namerno nudi samo agent-relevantan podskup ishoda. */
export async function submitResult(
  wsCtx: WorkstationAuthContext,
  jobId: string,
  attemptId: string,
  outcome: AgentResultOutcome,
  errorMessage?: string
) {
  const job = await prisma.printJob.findFirst({
    where: { id: jobId, restaurantId: wsCtx.restaurantId, locationId: wsCtx.locationId, station: wsCtx.station },
    select: { orderId: true },
  });
  if (!job) throw new Error("Print job nije pronađen");
  const result = await confirmPrintResult(workstationAsPrintClaimant(wsCtx), job.orderId, jobId, { attemptId, outcome, errorMessage });
  // Admin status ("poslednja predaja na štampu") — odvojeno od PrintJob
  // hardening-a iznad, isključivo informativno (isti princip kao
  // Device.lastSeenAt), namerno best-effort (greška ovde ne sme oboriti
  // rezultat koji je već ispravno zabeležen).
  await prisma.workstation.updateMany({ where: { id: wsCtx.workstationId }, data: { lastPrintAt: new Date() } }).catch(() => {});
  return result;
}

/**
 * Faza 2B — QZ koegzistencija (V1 politika, dokumentovano u finalnom
 * izveštaju): kad postoji BAR JEDNA omogućena, neopozvana radna stanica sa
 * NEDAVNIM heartbeat-om za TAČNO ovu restoran/lokacija/stanicu kombinaciju,
 * ta stanica se smatra "aktivnom" za Print Agent isporuku — browser/QZ
 * automatsko preuzimanje treba da se PASIVNO povuče (KdsClient.tsx ovo
 * čita i preskače sopstveni auto-claim), NIKAD da se takmiči za iste redove.
 * Ručna štampa sa browsera ostaje uvek dostupna, bez obzira na ovo.
 *
 * Ovo je NAMERNO odvojeno od beginPrintAttempt-ovog atomskog `updateMany`
 * (koji VEĆ strukturno sprečava da dva potrošača uspeju na ISTOM redu, bez
 * obzira na ovu proveru) — ovaj flag sprečava NEPOTREBNO/nasumično
 * takmičenje (koji transport "pobedi" trku bio bi nepredvidiv bez ovoga),
 * ne sam duplikat (taj je već nemoguć).
 */
// AGENT_ACTIVE_WINDOW_MS i sama "aktivan" provera žive u print-policy.ts
// (activeWorkstationFor) — JEDNO mesto, deljeno između dispatch-a
// (dispatchStationPrintJobs/listPendingStationPrintJobs) i ovog statusnog
// upita, da nikad ne mogu tiho da se razminu.
export async function isAgentActiveForStation(
  restaurantId: string,
  locationId: string,
  station: WorkstationStationValue
): Promise<boolean> {
  return Boolean(await activeWorkstationFor(prisma, restaurantId, locationId, station));
}

// Hardening audit (Part 13) — Admin's own "Automatska štampa: Spremna"
// (WorkstationsPanel.tsx silentPrintReady) already required
// isEnabled && online && configuredPrinterName && printerAvailable===true,
// but KDS's earlier stationPrinterStatus stopped at "hasWorkstation +
// isOnline" — meaning KDS could show "Štampač spreman" for a station whose
// Agent is online but whose configured Windows printer is missing/renamed.
// ONE discriminated state, computed HERE ONLY, is now the sole source of
// truth for BOTH surfaces — no second, slightly-different definition
// anywhere else.
export type PrinterReadinessState =
  | "READY"
  | "AGENT_OFFLINE"
  | "PRINTER_UNAVAILABLE"
  | "NOT_CONFIGURED";

export interface StationPrinterStatus {
  // Nijedna omogućena/neopozvana radna stanica nikad nije uparena za ovu
  // stanicu — Admin je nikad nije podesio (ili je opozvana/onemogućena).
  hasWorkstation: boolean;
  // Radna stanica postoji, ali joj heartbeat nije stigao u poslednja 2 min
  // (isti prag kao AGENT_ACTIVE_WINDOW_MS) — Windows Print Agent proces
  // verovatno nije pokrenut/nema mrežu, ne "nikad podešeno".
  isOnline: boolean;
  // Puno diskriminisano stanje — jedina stvar koju bi KDS/Admin treba da
  // prikažu kao "spremnost". LAST_PRINT_FAILED namerno NIJE ovde: to je
  // po-poslu (PrintJob) signal, ne po-stanici — pozivalac (KDS ruta) ga
  // sklapa preko VEĆ dobijene liste poslova, bez dodatnog upita ovde.
  state: PrinterReadinessState;
}

/**
 * Faza follow-up (KDS status ispravka + Part 13 hardening) — jedini
 * server-autoritativan izvor za "da li je štampač za ovu stanicu spreman"
 * koji i KDS i Admin treba da prikažu. NAMERNO nezavisno od QZ/browser
 * localStorage (getQzSettings) — to je po-računaru, ne server-strano
 * stanje, i ne sme biti "normalan" indikator spremnosti dok TableCore
 * Print Agent postoji kao stvaran put.
 */
export async function stationPrinterStatus(
  restaurantId: string,
  locationId: string,
  station: WorkstationStationValue
): Promise<StationPrinterStatus> {
  const workstation = await prisma.workstation.findFirst({
    where: { restaurantId, locationId, station, isEnabled: true, revokedAt: null },
    select: { lastSeenAt: true, configuredPrinterName: true, printerAvailable: true },
    orderBy: { lastSeenAt: "desc" },
  });
  if (!workstation) return { hasWorkstation: false, isOnline: false, state: "NOT_CONFIGURED" };
  const isOnline = Boolean(workstation.lastSeenAt && workstation.lastSeenAt.getTime() > Date.now() - AGENT_ACTIVE_WINDOW_MS);
  if (!isOnline) return { hasWorkstation: true, isOnline: false, state: "AGENT_OFFLINE" };
  // printerAvailable === true is required, not just "not false" — null
  // means the agent has not reported yet (fresh pairing, printer choice
  // not yet confirmed against the live Windows printer list), which is
  // exactly as un-ready as a confirmed-missing printer for this purpose.
  if (!workstation.configuredPrinterName || workstation.printerAvailable !== true) {
    return { hasWorkstation: true, isOnline: true, state: "PRINTER_UNAVAILABLE" };
  }
  return { hasWorkstation: true, isOnline: true, state: "READY" };
}
