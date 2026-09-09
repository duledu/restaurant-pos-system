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
const AGENT_ACTIVE_WINDOW_MS = 2 * 60 * 1000;

export async function isAgentActiveForStation(
  restaurantId: string,
  locationId: string,
  station: WorkstationStationValue
): Promise<boolean> {
  const active = await prisma.workstation.findFirst({
    where: {
      restaurantId,
      locationId,
      station,
      isEnabled: true,
      revokedAt: null,
      lastSeenAt: { gt: new Date(Date.now() - AGENT_ACTIVE_WINDOW_MS) },
    },
    select: { id: true },
  });
  return Boolean(active);
}
