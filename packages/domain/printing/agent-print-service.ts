/**
 * Faza 2B — TableCore Print Agent isporuka. NAMERNO ne uvodi novi
 * state-machine za PrintJob — u potpunosti PONOVO KORISTI
 * beginPrintAttempt/startPrintSubmission/confirmPrintResult iz
 * print-service.ts (nepromenjene, već dokazane na 69/69 combined
 * integration). Jedina nova stvar ovde je KAKO se do tih funkcija dolazi
 * kad pozivalac nije zaposleni nego autentifikovana radna stanica.
 *
 * Printing V2 — jedan Workstation sad može imati VIŠE nezavisnih
 * WorkstationPrintRoute (KITCHEN/BAR/RECEIPT), pa "koju stanicu ovaj agent
 * poslužuje" više NIJE `wsCtx.station` (DEPRECATED, nullable — vidi
 * packages/auth/workstation-auth.ts) nego jedna sveža upit protiv te
 * tabele, urađena na početku svake od tri funkcije ispod. `PrintJob.type`
 * (ne `.station`, koje je null za RECEIPT) je zajednički ključ preko koga se
 * KITCHEN/BAR/RECEIPT poslovi uniformno filtriraju — jedan agent sa sve tri
 * omogućene rute vidi/kandiduje poslove sva tri tipa kroz IDENTIČAN upit.
 *
 * `workstationAsPrintClaimant` gradi AuthContext-oblik iz
 * WorkstationAuthContext-a + trenutnih tipova ruta: `restaurantId`/
 * `locationIds`/`roles` se postavljaju TAČNO iz autentifikovanog identiteta
 * radne stanice i njenih AKTIVNIH ruta (nikad iz bilo čega što agent tvrdi u
 * telu zahteva), pa postojeće provere (scopeToRestaurant, requireLocationAccess,
 * assertStationAccess) VEĆ ispravno ograničavaju agenta na sopstveni
 * restoran/lokaciju/rute — bez ijedne nove provere. `claimedBy` postaje
 * `workstation:<id>`, jasno razlučivo od pravog employeeId-a (uvek UUID bez
 * prefiksa) u audit tragu/DB redu.
 */
import { prisma } from "@rcs/db";
import type { AuthContext, WorkstationAuthContext, WorkstationStationValue } from "@rcs/auth";
import { beginPrintAttempt, startPrintSubmission, confirmPrintResult, STALE_PRINT_LEASE_MS } from "./print-service";
import { activeWorkstationFor, AGENT_ACTIVE_WINDOW_MS } from "./print-policy";

export type PrintRouteTypeValue = "KITCHEN" | "BAR" | "RECEIPT";

/** Sveži spisak tipova ruta ovog Workstation-a koje su trenutno omogućene —
 * NAMERNO upitano po pozivu (ne keširano na wsCtx), jer se Admin može
 * promeniti između dva poll ciklusa i agent MORA odmah videti novo stanje. */
async function activeRouteTypes(workstationId: string): Promise<PrintRouteTypeValue[]> {
  const routes = await prisma.workstationPrintRoute.findMany({
    where: { workstationId, isEnabled: true },
    select: { type: true },
  });
  return routes.map((r) => r.type) as PrintRouteTypeValue[];
}

function workstationAsPrintClaimant(wsCtx: WorkstationAuthContext, routeTypes: PrintRouteTypeValue[]): AuthContext {
  const claimantId = `workstation:${wsCtx.workstationId}`;
  return {
    userId: claimantId,
    employeeId: claimantId,
    restaurantId: wsCtx.restaurantId,
    locationIds: [wsCtx.locationId],
    roles: routeTypes,
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
 * restoran/lokaciju autentifikovane radne stanice, ograničen na tipove NJENIH
 * trenutno omogućenih ruta (KITCHEN/BAR/RECEIPT — može biti jedna, dve ili
 * sve tri), pa ga odmah kandiduje preko beginPrintAttempt (nepromenjeno).
 * Vraća `null` ako nema ništa, ako agent nema nijednu omogućenu rutu, ILI
 * ako je izgubljena trka za kandidata (druga radna stanica ILI KDS/QZ
 * browser put ga je uzeo u međuvremenu) — svi slučajevi su normalni, ne
 * greška; pozivalac (agent) samo pokušava ponovo na sledećem poll-u. I dalje
 * vraća NAJVIŠE JEDAN posao po pozivu (bez promene HTTP oblika prema
 * agentu) — čak i kad agent poslužuje tri rute, i dalje postoji tačno jedna
 * poll->print->report petlja, pa je fizičko izvršenje i dalje strogo
 * serijsko bez ikakve nove konkurentnosti.
 *
 * Sopstveni "stale recovery" prolaz (isti prag/logika kao
 * listPendingStationPrintJobs) je OBAVEZAN ovde — agent može biti JEDINI
 * potrošač ovih ruta (KDS tab može biti zatvoren), pa niko drugi možda
 * nikad ne pokrene taj prolaz za redove van trenutnog kandidata.
 */
export async function pollAndClaim(wsCtx: WorkstationAuthContext): Promise<AgentTicketPayload | null> {
  const { restaurantId, locationId } = wsCtx;
  const routeTypes = await activeRouteTypes(wsCtx.workstationId);
  if (routeTypes.length === 0) return null;
  const staleThreshold = new Date(Date.now() - STALE_PRINT_LEASE_MS);

  await prisma.printJob.updateMany({
    where: {
      restaurantId,
      locationId,
      type: { in: routeTypes },
      status: "PRINTING",
      attemptId: { not: null },
      submissionStartedAt: null,
      claimedAt: { lt: staleThreshold },
    },
    data: { status: "PENDING", attemptId: null, claimedBy: null, claimedAt: null },
  });
  await prisma.printJob.updateMany({
    where: { restaurantId, locationId, type: { in: routeTypes }, status: "PRINTING", submissionStartedAt: { lt: staleThreshold } },
    data: { status: "SUBMISSION_UNKNOWN", failureReason: "Potvrda štampe nedostaje; proverite štampač pre novog otiska." },
  });

  // isAutomatic:true — namerno: ručna štampa/reprint ostaju NEZAVISNI od
  // agent poll-a u ovoj fazi (zahtev specifikacije "Do NOT over-expand
  // scope"). status:"PENDING" nikad uključuje SUPPRESSED (drugačija
  // vrednost enuma) — poll endpoint stoga strukturno nikad ne vraća
  // suzbijene automatske redove. `type` (ne `station`, koje je null za
  // RECEIPT) je filter — jedini zajednički ključ preko sva tri tipa rute.
  const candidate = await prisma.printJob.findFirst({
    where: { restaurantId, locationId, type: { in: routeTypes }, status: "PENDING", isAutomatic: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, orderId: true },
  });
  if (!candidate) return null;

  const claimantCtx = workstationAsPrintClaimant(wsCtx, routeTypes);
  const claimed = await beginPrintAttempt(claimantCtx, candidate.orderId, candidate.id);
  if (!claimed || !claimed.attemptId) return null;

  return {
    jobId: claimed.id,
    attemptId: claimed.attemptId,
    // `station` je null za RECEIPT (nikad vezan za jednu kuhinja/šank
    // stanicu) — agentu se u tom slučaju šalje `type` ("RECEIPT") pod istim
    // JSON poljem, agent ionako gleda ovo polje samo da pronađe SVOJU
    // odgovarajuću lokalnu rutu po tipu, ne da uslovljava produkciono stanje.
    station: (claimed.station ?? claimed.type) as WorkstationStationValue,
    documentType: claimed.type,
    isReprint: claimed.isReprint,
    attemptCount: claimed.attemptCount,
    content: claimed.content,
  };
}

/** "I am about to begin the external side effect" — mora prethoditi
 * PrintDocument.Print pozivu na agentu. Ponovo koristi
 * startPrintSubmission nepromenjeno. Job se traži samo po
 * {id, restaurantId, locationId} (ne više po tačnoj `station` jednakosti —
 * ta kolona je null za RECEIPT); `job.type` mora biti jedan od TRENUTNO
 * omogućenih tipova ruta ovog agenta — odbrana u dubinu protiv zbunjenog
 * ili kompromitovanog agenta koji tvrdi tuđi posao za stvaran fizički
 * efekat (assertStationAccess unutar startPrintSubmission dodatno proverava
 * `roles` za KITCHEN/BAR poslove). */
export async function beginSubmission(wsCtx: WorkstationAuthContext, jobId: string, attemptId: string) {
  const routeTypes = await activeRouteTypes(wsCtx.workstationId);
  const job = await prisma.printJob.findFirst({
    where: { id: jobId, restaurantId: wsCtx.restaurantId, locationId: wsCtx.locationId },
    select: { orderId: true, type: true },
  });
  if (!job || !routeTypes.includes(job.type as PrintRouteTypeValue)) throw new Error("Print job nije pronađen");
  return startPrintSubmission(workstationAsPrintClaimant(wsCtx, routeTypes), job.orderId, jobId, attemptId);
}

export type AgentResultOutcome = "SUBMITTED_TO_SPOOLER" | "FAILED_BEFORE_SUBMISSION" | "SUBMISSION_UNKNOWN";

/** Ponovo koristi confirmPrintResult nepromenjeno — isto polje
 * `resultOutcome` prihvata i TRANSPORT_COMPLETED (browser put), ovde se
 * agentu namerno nudi samo agent-relevantan podskup ishoda. Ista
 * {id, restaurantId, locationId} + aktivne rute provera kao beginSubmission. */
export async function submitResult(
  wsCtx: WorkstationAuthContext,
  jobId: string,
  attemptId: string,
  outcome: AgentResultOutcome,
  errorMessage?: string
) {
  const routeTypes = await activeRouteTypes(wsCtx.workstationId);
  const job = await prisma.printJob.findFirst({
    where: { id: jobId, restaurantId: wsCtx.restaurantId, locationId: wsCtx.locationId },
    select: { orderId: true, type: true },
  });
  if (!job || !routeTypes.includes(job.type as PrintRouteTypeValue)) throw new Error("Print job nije pronađen");
  const result = await confirmPrintResult(workstationAsPrintClaimant(wsCtx, routeTypes), job.orderId, jobId, { attemptId, outcome, errorMessage });
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
  type: PrintRouteTypeValue
): Promise<boolean> {
  return Boolean(await activeWorkstationFor(prisma, restaurantId, locationId, type));
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
 *
 * Printing V2 — widened from Workstation.station (KITCHEN|BAR only) to any
 * WorkstationPrintRoute type (KITCHEN|BAR|RECEIPT): eligibility now comes
 * from an enabled route row joined to its parent workstation, not a scalar
 * column, which is what finally lets RECEIPT get a real readiness state too
 * (previously RECEIPT had no Agent path at all). KDS's two call sites
 * (apps/web/app/api/production/{kitchen,bar}/print-jobs/route.ts) and
 * KdsClient.tsx need ZERO changes — they only ever passed KITCHEN/BAR and
 * still do; this signature change is additive.
 */
export async function stationPrinterStatus(
  restaurantId: string,
  locationId: string,
  type: PrintRouteTypeValue
): Promise<StationPrinterStatus> {
  const route = await prisma.workstationPrintRoute.findFirst({
    where: {
      restaurantId,
      locationId,
      type,
      isEnabled: true,
      workstation: { isEnabled: true, revokedAt: null },
    },
    select: {
      printerName: true,
      printerAvailable: true,
      workstation: { select: { lastSeenAt: true, availablePrinters: true } },
    },
    orderBy: { workstation: { lastSeenAt: "desc" } },
  });
  if (!route) return { hasWorkstation: false, isOnline: false, state: "NOT_CONFIGURED" };
  const isOnline = Boolean(route.workstation.lastSeenAt && route.workstation.lastSeenAt.getTime() > Date.now() - AGENT_ACTIVE_WINDOW_MS);
  if (!isOnline) return { hasWorkstation: true, isOnline: false, state: "AGENT_OFFLINE" };
  // False-"Štampač nedostupan" root cause (Part B) — printerAvailable===false
  // is a proven per-route signal (the Agent checked THIS route's printer
  // against the live Windows list and it wasn't there): always trust it.
  // printerAvailable===null only means "not yet reconfirmed since the route
  // was last saved" (see upsertPrintRoute) — every heartbeat unconditionally
  // refreshes workstation.availablePrinters (the Agent's full enumeration),
  // so while waiting for the next per-route confirmation, fall back to that
  // fresher, never-artificially-reset signal instead of assuming the worst.
  // Never invents availability out of thin air: if the Agent were offline or
  // had never reported printers, isOnline above / an empty list here already
  // fails this check, same as before.
  const availablePrinters = route.workstation.availablePrinters as string[] | null;
  const listedAsAvailable = route.printerName != null && (availablePrinters?.includes(route.printerName) ?? false);
  const printerReady = route.printerAvailable === true || (route.printerAvailable === null && listedAsAvailable);
  if (!route.printerName || !printerReady) {
    return { hasWorkstation: true, isOnline: true, state: "PRINTER_UNAVAILABLE" };
  }
  return { hasWorkstation: true, isOnline: true, state: "READY" };
}
