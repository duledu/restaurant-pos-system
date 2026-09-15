/**
 * Faza 2A — TableCore Print Agent radne stanice: admin-strana uparivanja
 * (createPairing/cancelPairing/listWorkstations/revokeWorkstation, sve
 * kroz AuthContext, isti obrazac kao device-service.ts) i agent-strana
 * (registerAgentFromPairing/recordHeartbeat, BEZ AuthContext-a — agent
 * nije zaposleni, vidi packages/auth/workstation-auth.ts).
 *
 * KLJUČNO PRAVILO (isto kao printing/print-policy.ts): svaka mutacija koja
 * dotiče lokaciju prvo zaključava tenant-owned location red
 * (lockPrintLocation) unutar transakcije — isti redosled brave svuda.
 */
import { Prisma, prisma } from "@rcs/db";
import {
  requirePermission,
  requireLocationAccess,
  scopeToRestaurant,
  generatePairingCode,
  hashPairingCode,
  generateWorkstationCredential,
  hashWorkstationCredential,
  WORKSTATION_CREDENTIAL_VERSION,
  type AuthContext,
  type WorkstationAuthContext,
} from "@rcs/auth";
import {
  createWorkstationPairingSchema,
  consumeWorkstationPairingSchema,
  workstationHeartbeatSchema,
  agentTestPrintResultSchema,
  updateWorkstationSchema,
  upsertPrintRouteSchema,
  printRouteTypeSchema,
  type CreateWorkstationPairingInput,
  type ConsumeWorkstationPairingInput,
  type WorkstationHeartbeatInput,
  type AgentTestPrintResultInput,
  type UpdateWorkstationInput,
  type UpsertPrintRouteInput,
  type PrintRouteType,
} from "@rcs/shared";
import { recordAuditEntry } from "../audit/audit-service";
import { lockPrintLocation } from "../printing/print-policy";

const WORKSTATIONS_MANAGE = "workstations.manage";

// Kratkotrajno — dovoljno da admin generiše kod i preda ga/pročita agentu
// (ili QR/setup wizard u budućoj fazi) pre nego što neko pokuša ponovnu
// upotrebu. Vidi packages/auth/workstation-auth.ts za entropiju koda.
const PAIRING_EXPIRY_MS = 10 * 60 * 1000;

// Baca isti generički tekst za NEPOSTOJEĆI/ISTEKAO/POTROŠEN/OTKAZAN kod —
// ruta (apps/web/app/api/agent/register/route.ts) mora vratiti IDENTIČAN
// odgovor za sva četiri slučaja, da se ne može enumerisati koji je razlog
// (isti princip kao GENERIC_ERROR u pin-login/route.ts).
const PAIRING_INVALID_MESSAGE = "Kod za uparivanje je nevažeći, istekao je ili je već iskorišćen";

// Eksplicitna "safe select" za SVAKI upit čiji rezultat može stići do
// Admin API odgovora — NIKAD `codeHash`/`credentialHash`/`credentialVersion`.
// Odbrana u dubinu: heš sam po sebi nije reverzibilan, ali nema nijedan
// legitiman razlog da ga browser ikad vidi (isti princip kao što
// qz-certificate/route.ts vraća SAMO signingConfigured boolean, nikad
// privatni ključ/sertifikat detalje van onoga što QZ Tray stvarno treba).
const WORKSTATION_PUBLIC_SELECT = {
  id: true,
  restaurantId: true,
  locationId: true,
  name: true,
  station: true,
  configuredPrinterName: true,
  printerAvailable: true,
  paperWidthMm: true,
  // Printing V2 — pun spisak Windows štampača te mašine (za Admin dropdown)
  // i po-ruti podešavanja (rute štampe, ne više jedna stanica po računaru).
  availablePrinters: true,
  printersReportedAt: true,
  printRoutes: {
    select: {
      id: true,
      type: true,
      printerName: true,
      paperWidthMm: true,
      printerAvailable: true,
      isEnabled: true,
      updatedAt: true,
    },
  },
  agentVersion: true,
  osDescription: true,
  isEnabled: true,
  lastSeenAt: true,
  lastSuccessfulCommunicationAt: true,
  lastPrintAt: true,
  testPrintRequestedAt: true,
  testPrintRouteType: true,
  testPrintStatus: true,
  testPrintCompletedAt: true,
  testPrintError: true,
  pairedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
  location: { select: { id: true, name: true } },
} as const;

const PAIRING_PUBLIC_SELECT = {
  id: true,
  restaurantId: true,
  locationId: true,
  station: true,
  name: true,
  status: true,
  expiresAt: true,
  consumedAt: true,
  workstationId: true,
  createdBy: true,
  createdAt: true,
  location: { select: { id: true, name: true } },
} as const;

// ─────────────────────────────────────────────────────────────────────────
// ADMIN — uparivanje
// ─────────────────────────────────────────────────────────────────────────

export interface CreatedPairing {
  pairingId: string;
  code: string;
  expiresAt: Date;
  // Printing V2 — null je NORMALAN, očekivan slučaj (novi Admin tok
  // uparivanja ne bira stanicu unapred); vidi napomenu na
  // createWorkstationPairingSchema.
  station: "KITCHEN" | "BAR" | null;
  locationId: string;
  name: string | null;
}

export async function createPairing(ctx: AuthContext, input: CreateWorkstationPairingInput): Promise<CreatedPairing> {
  requirePermission(ctx, WORKSTATIONS_MANAGE);
  const data = createWorkstationPairingSchema.parse(input);
  requireLocationAccess(ctx, data.locationId);

  return prisma.$transaction(async (tx) => {
    await lockPrintLocation(tx, ctx.restaurantId, data.locationId);

    const code = generatePairingCode();
    const codeHash = hashPairingCode(code);
    const expiresAt = new Date(Date.now() + PAIRING_EXPIRY_MS);

    const pairing = await tx.workstationPairing.create({
      data: {
        restaurantId: ctx.restaurantId,
        locationId: data.locationId,
        station: data.station,
        name: data.name,
        codeHash,
        expiresAt,
        createdBy: ctx.employeeId,
      },
    });

    await recordAuditEntry(
      ctx,
      {
        entityType: "WorkstationPairing",
        entityId: pairing.id,
        action: "workstation_pairing.created",
        newValue: { locationId: data.locationId, station: data.station, expiresAt },
        locationId: data.locationId,
      },
      tx
    );

    // Sirov kod se vraća SAMO ovde, jednom — nikad ponovo čitljiv iz baze.
    return { pairingId: pairing.id, code, expiresAt, station: pairing.station, locationId: pairing.locationId, name: pairing.name };
  });
}

/**
 * Otkazuje NEISKORIŠĆENU sesiju uparivanja. Race-safe protiv istovremene
 * potrošnje od strane agenta: uslovan `updateMany` (WHERE status='PENDING')
 * umesto findFirst+update — ako je agent baš u tom trenutku potrošio kod,
 * `count` je 0 i ništa se ne prepisuje (isti obrazac kao beginPrintAttempt
 * u print-service.ts). Idempotentno na već-otkazan/potrošen zahtev.
 */
export async function cancelPairing(ctx: AuthContext, pairingId: string) {
  requirePermission(ctx, WORKSTATIONS_MANAGE);

  const claim = await prisma.workstationPairing.updateMany({
    where: { id: pairingId, restaurantId: ctx.restaurantId, status: "PENDING" },
    data: { status: "CANCELLED" },
  });

  const current = await prisma.workstationPairing.findFirst({
    where: { id: pairingId, restaurantId: ctx.restaurantId },
    select: PAIRING_PUBLIC_SELECT,
  });
  if (!current) throw new Error("Sesija uparivanja nije pronađena");
  if (claim.count === 0) return current; // već potrošena/otkazana — no-op

  await recordAuditEntry(ctx, {
    entityType: "WorkstationPairing",
    entityId: pairingId,
    action: "workstation_pairing.cancelled",
    previousValue: { status: "PENDING" },
    newValue: { status: "CANCELLED" },
    locationId: current.locationId,
  });

  return current;
}

export async function listPendingPairings(ctx: AuthContext) {
  requirePermission(ctx, WORKSTATIONS_MANAGE);
  return prisma.workstationPairing.findMany({
    where: { ...scopeToRestaurant(ctx), status: "PENDING", expiresAt: { gt: new Date() } },
    select: PAIRING_PUBLIC_SELECT,
    orderBy: { createdAt: "desc" },
  });
}

export async function listWorkstations(ctx: AuthContext) {
  requirePermission(ctx, WORKSTATIONS_MANAGE);
  return prisma.workstation.findMany({
    where: scopeToRestaurant(ctx),
    select: WORKSTATION_PUBLIC_SELECT,
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Trajno oduzima pristup jednoj radnoj stanici — `revokedAt` je nepovratno
 * (nova upotreba iste fizičke mašine zahteva NOVO uparivanje, ne
 * "un-revoke"). `isEnabled=false` se postavlja usput iz istog razloga koji
 * su heartbeat/agent rute proveravaju oba polja (odbrana u dubinu, ne dva
 * nezavisna izvora istine). Idempotentno.
 */
export async function revokeWorkstation(ctx: AuthContext, workstationId: string) {
  requirePermission(ctx, WORKSTATIONS_MANAGE);

  const workstation = await prisma.workstation.findFirst({
    where: { id: workstationId, ...scopeToRestaurant(ctx) },
    select: WORKSTATION_PUBLIC_SELECT,
  });
  if (!workstation) throw new Error("Radna stanica nije pronađena");
  if (workstation.revokedAt) return workstation;

  const now = new Date();
  const updated = await prisma.workstation.update({
    where: { id: workstationId },
    data: { revokedAt: now, isEnabled: false },
    select: WORKSTATION_PUBLIC_SELECT,
  });

  await recordAuditEntry(ctx, {
    entityType: "Workstation",
    entityId: workstationId,
    action: "workstation.revoked",
    previousValue: { revokedAt: null, isEnabled: workstation.isEnabled },
    newValue: { revokedAt: now, isEnabled: false },
    locationId: workstation.locationId,
  });

  return updated;
}

/**
 * Admin "Podešavanja" na već upareneoj radnoj stanici — preimenovanje i
 * privremeno uključi/isključi (reverzibilno, za razliku od revokeWorkstation
 * koje je trajno). Namerno odbija opozvanu stanicu (nema šta da se "podesi"
 * na nečemu što više ne može da se poveže — treba novo uparivanje).
 */
export async function updateWorkstation(ctx: AuthContext, workstationId: string, input: UpdateWorkstationInput) {
  requirePermission(ctx, WORKSTATIONS_MANAGE);
  const data = updateWorkstationSchema.parse(input);

  const workstation = await prisma.workstation.findFirst({
    where: { id: workstationId, ...scopeToRestaurant(ctx) },
    select: WORKSTATION_PUBLIC_SELECT,
  });
  if (!workstation) throw new Error("Radna stanica nije pronađena");
  if (workstation.revokedAt) throw new Error("Radna stanica je opozvana — potrebno je novo uparivanje");

  const updated = await prisma.workstation.update({
    where: { id: workstationId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.isEnabled !== undefined ? { isEnabled: data.isEnabled } : {}),
    },
    select: WORKSTATION_PUBLIC_SELECT,
  });

  await recordAuditEntry(ctx, {
    entityType: "Workstation",
    entityId: workstationId,
    action: "workstation.updated",
    previousValue: { name: workstation.name, isEnabled: workstation.isEnabled },
    newValue: { name: updated.name, isEnabled: updated.isEnabled },
    locationId: workstation.locationId,
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// Printing V2 — ADMIN, rute štampe (KITCHEN/BAR/RECEIPT po računaru)
// ─────────────────────────────────────────────────────────────────────────

const PRINT_ROUTE_SELECT = {
  id: true,
  workstationId: true,
  type: true,
  printerName: true,
  paperWidthMm: true,
  printerAvailable: true,
  isEnabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function loadOwnedWorkstation(ctx: AuthContext, workstationId: string) {
  const workstation = await prisma.workstation.findFirst({
    where: { id: workstationId, ...scopeToRestaurant(ctx) },
    select: { id: true, restaurantId: true, locationId: true, revokedAt: true },
  });
  if (!workstation) throw new Error("Radna stanica nije pronađena");
  return workstation;
}

export async function listPrintRoutes(ctx: AuthContext, workstationId: string) {
  requirePermission(ctx, WORKSTATIONS_MANAGE);
  await loadOwnedWorkstation(ctx, workstationId);
  return prisma.workstationPrintRoute.findMany({
    where: { workstationId },
    select: PRINT_ROUTE_SELECT,
    orderBy: { type: "asc" },
  });
}

/**
 * Kreira ILI menja TAČNO JEDNU rutu štampe (KITCHEN/BAR/RECEIPT) na već
 * uparenom računaru — nikad ne zahteva novo uparivanje. Isti fizički
 * štampač sme da se ponovi u više ruta istog računara (nema unique po
 * printerName) — jedino ograničenje je jedna ruta po (workstationId, type),
 * primenjeno preko upsert-a. `requireLocationAccess` preko lokacije SAME
 * radne stanice (ne iz tela zahteva) — Admin ne može da tvrdi lokaciju za
 * tuđi računar.
 */
export async function upsertPrintRoute(
  ctx: AuthContext,
  workstationId: string,
  type: PrintRouteType,
  input: UpsertPrintRouteInput
) {
  requirePermission(ctx, WORKSTATIONS_MANAGE);
  const routeType = printRouteTypeSchema.parse(type);
  const data = upsertPrintRouteSchema.parse(input);
  const workstation = await loadOwnedWorkstation(ctx, workstationId);
  requireLocationAccess(ctx, workstation.locationId);
  if (workstation.revokedAt) throw new Error("Radna stanica je opozvana — potrebno je novo uparivanje");

  const previous = await prisma.workstationPrintRoute.findUnique({
    where: { workstationId_type: { workstationId, type: routeType } },
    select: PRINT_ROUTE_SELECT,
  });

  const route = await prisma.workstationPrintRoute.upsert({
    where: { workstationId_type: { workstationId, type: routeType } },
    create: {
      restaurantId: workstation.restaurantId,
      locationId: workstation.locationId,
      workstationId,
      type: routeType,
      printerName: data.printerName ?? null,
      paperWidthMm: data.paperWidthMm ?? null,
      isEnabled: data.isEnabled ?? true,
    },
    update: {
      ...(data.printerName !== undefined ? { printerName: data.printerName, printerAvailable: null } : {}),
      ...(data.paperWidthMm !== undefined ? { paperWidthMm: data.paperWidthMm } : {}),
      ...(data.isEnabled !== undefined ? { isEnabled: data.isEnabled } : {}),
    },
    select: PRINT_ROUTE_SELECT,
  });

  await recordAuditEntry(ctx, {
    entityType: "WorkstationPrintRoute",
    entityId: route.id,
    action: "workstation.route_updated",
    previousValue: previous
      ? { printerName: previous.printerName, paperWidthMm: previous.paperWidthMm, isEnabled: previous.isEnabled }
      : null,
    newValue: { workstationId, type: routeType, printerName: route.printerName, paperWidthMm: route.paperWidthMm, isEnabled: route.isEnabled },
    locationId: workstation.locationId,
  });

  return route;
}

/**
 * Faza 2C — Admin "Test Print" dugme. Namerno NE kreira PrintJob/Order
 * (test štampa ne sme dotaći accounting/izveštaje) — samo postavlja
 * zastavicu na Workstation red koju agent vidi kroz SLEDEĆI heartbeat/poll
 * (recordHeartbeat/isTestPrintPending ispod vraćaju testPrintRequested +
 * testPrintRoute) i lokalno štampa preko WindowsPrinter.Print, van
 * AgentRunner/AgentDatabase puta za prave tikete. Idempotentno na uzastopne
 * klikove dok je prethodni zahtev još PENDING — jednostavno ponovo
 * postavlja isto stanje (agent štampa najviše jednom po heartbeat/poll
 * ciklusu u kom primeti zastavicu, ne akumulira duple zahteve).
 *
 * Printing V2 — mora se navesti KOJU rutu (KITCHEN/BAR/RECEIPT) testirati,
 * jer jedan agent sad može imati više različitih štampača; agent lokalno
 * bira odgovarajući štampač/širinu iz SVOJE Routes liste po ovom tipu
 * (server ovde ne šalje printerName — samo tip, isti princip kao pravi
 * poslovi: agent je jedini koji sme fizički da bira štampač). Ruta mora već
 * biti podešena (imati printerName) — testiranje neupisane rute nema šta
 * da testira.
 */
export async function requestTestPrint(ctx: AuthContext, workstationId: string, routeType: PrintRouteType) {
  requirePermission(ctx, WORKSTATIONS_MANAGE);
  const type = printRouteTypeSchema.parse(routeType);

  const workstation = await prisma.workstation.findFirst({
    where: { id: workstationId, ...scopeToRestaurant(ctx) },
    select: { id: true, locationId: true, revokedAt: true, isEnabled: true },
  });
  if (!workstation) throw new Error("Radna stanica nije pronađena");
  if (workstation.revokedAt || !workstation.isEnabled) {
    throw new Error("Radna stanica je opozvana ili onemogućena — test štampa nije moguća");
  }
  const route = await prisma.workstationPrintRoute.findUnique({
    where: { workstationId_type: { workstationId, type } },
    select: { printerName: true },
  });
  if (!route?.printerName) {
    throw new Error("Ova ruta nema izabran štampač — podesi štampač pre testa");
  }

  const now = new Date();
  const updated = await prisma.workstation.update({
    where: { id: workstationId },
    data: {
      testPrintRequestedAt: now,
      testPrintRequestedBy: ctx.employeeId,
      testPrintRouteType: type,
      testPrintStatus: "PENDING",
      testPrintCompletedAt: null,
      testPrintError: null,
    },
    select: WORKSTATION_PUBLIC_SELECT,
  });

  await recordAuditEntry(ctx, {
    entityType: "Workstation",
    entityId: workstationId,
    action: "workstation.test_print_requested",
    newValue: { requestedAt: now },
    locationId: workstation.locationId,
  });

  return updated;
}

/**
 * Agent-strana — prijavljuje ishod SVOJE lokalno izvedene testne štampe.
 * Server ovde NE presuđuje da li je štampa stvarno uspela (isto pravilo
 * kao SUBMITTED_TO_SPOOLER za prave tikete — "predato spuleru" nije
 * "papir izašao"), samo pamti šta je agent prijavio radi Admin prikaza.
 */
export async function recordTestPrintResult(wsCtx: WorkstationAuthContext, input: AgentTestPrintResultInput): Promise<void> {
  const parsed = agentTestPrintResultSchema.parse(input);
  await prisma.workstation.updateMany({
    where: { id: wsCtx.workstationId },
    data: {
      testPrintStatus: parsed.status,
      testPrintCompletedAt: new Date(),
      testPrintError: parsed.status === "FAILED" ? (parsed.errorMessage ?? "Nepoznata greška") : null,
    },
  });
}

/**
 * Faza 2C, sekcija 8 — DB NIKAD ne čuva instalacioni binarni fajl, samo
 * (opcionu) referencu na gde je objavljen. `PRINT_AGENT_INSTALLER_URL` je
 * namerno server-strani environment promenljiva (NE nešto što restoranski
 * menadžer ikad podešava) — kad nije postavljena, Admin panel iskreno
 * prikazuje "instaler još nije objavljen" umesto polomljenog linka ili
 * izmišljene URL adrese.
 */
export function getAgentDownloadInfo(ctx: AuthContext) {
  requirePermission(ctx, WORKSTATIONS_MANAGE);
  const url = process.env.PRINT_AGENT_INSTALLER_URL?.trim() || null;
  return {
    available: Boolean(url),
    url,
    // Interna pilot oznaka — MORA se poklapati sa verzijom OBJAVLJENOG
    // GitHub Release instalera koji ovaj URL stvarno servira (ne nužno sa
    // najnovijim AgentVersion.Current u kodu — vidi Printing V2 napomenu:
    // pilot.3 je izgrađen lokalno za fizički QA i namerno NIJE objavljen
    // ovde dok fizički test ne prođe). Ažuriraj TEK kad se GitHub Release
    // asset stvarno zameni.
    version: "1.0.0-pilot.2",
    supportedOS: "Windows 10 64-bit, Windows 11 64-bit (Windows 11 physical hardware acceptance pending)",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// AGENT — registracija preko uparivanja, autentifikovan heartbeat
// ─────────────────────────────────────────────────────────────────────────

export class WorkstationPairingError extends Error {}

export interface RegisteredWorkstation {
  workstationId: string;
  credential: string;
  restaurantId: string;
  locationId: string;
  // Printing V2 — DEPRECATED, null for every new pairing created without
  // the legacy optional `station` shortcut. Never used to decide print
  // eligibility in new code; see WorkstationPrintRoute.
  station: "KITCHEN" | "BAR" | null;
  name: string;
}

/**
 * Potrošnja uparivanja — race-safe (dva agenta ne mogu oba uspeti sa istim
 * kodom): atomski uslovan `updateMany` (WHERE status='PENDING' AND
 * expiresAt > now) unutar transakcije zaključava BAŠ TAJ red preko
 * Postgres MVCC-a; konkurentan poziv koji stigne posle vidi već-CONSUMED
 * status i njegov `count` je 0. Isti obrazac kao beginPrintAttempt.
 *
 * Sirov `credential` se vraća TAČNO OVDE, jednom — server ga posle ovoga
 * NIKAD više ne vidi u čistom tekstu (samo credentialHash).
 */
export async function registerAgentFromPairing(input: ConsumeWorkstationPairingInput): Promise<RegisteredWorkstation> {
  const parsed = consumeWorkstationPairingSchema.parse(input);
  const codeHash = hashPairingCode(parsed.code);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const claim = await tx.workstationPairing.updateMany({
      where: { codeHash, status: "PENDING", expiresAt: { gt: now } },
      data: { status: "CONSUMED", consumedAt: now },
    });
    if (claim.count !== 1) {
      throw new WorkstationPairingError(PAIRING_INVALID_MESSAGE);
    }

    const pairing = await tx.workstationPairing.findUnique({ where: { codeHash } });
    if (!pairing) throw new WorkstationPairingError(PAIRING_INVALID_MESSAGE); // odbrambeno, ne bi trebalo da se desi

    // Re-proveri da tenant/lokacija i dalje postoje/pripadaju u trenutku
    // potrošnje (ista brava kao admin-strana kreiranja) — odbacuje
    // teorijski slučaj gde je lokacija izbrisana/premeštena između
    // kreiranja i potrošnje uparivanja.
    await lockPrintLocation(tx, pairing.restaurantId, pairing.locationId);

    const rawCredential = generateWorkstationCredential();
    const credentialHash = hashWorkstationCredential(rawCredential);

    const workstation = await tx.workstation.create({
      data: {
        restaurantId: pairing.restaurantId,
        locationId: pairing.locationId,
        station: pairing.station,
        name: pairing.name?.trim() || (pairing.station ? `Radna stanica — ${pairing.station}` : "Novi računar"),
        credentialHash,
        credentialVersion: WORKSTATION_CREDENTIAL_VERSION,
        agentVersion: parsed.agentVersion,
        osDescription: parsed.osDescription,
        pairedAt: now,
      },
    });

    // Printing V2 backward-compat shortcut — a pairing created with the
    // (now optional/deprecated) `station` field pre-provisions ONE matching
    // WorkstationPrintRoute immediately, unconfigured (no printer yet), so
    // callers that still pair with a station keep working against the new
    // route-based dispatch/status/claim logic with no other change needed.
    // The normal Admin flow omits `station` entirely and configures routes
    // afterward via upsertPrintRoute.
    if (pairing.station) {
      await tx.workstationPrintRoute.create({
        data: {
          restaurantId: pairing.restaurantId,
          locationId: pairing.locationId,
          workstationId: workstation.id,
          type: pairing.station,
          isEnabled: true,
        },
      });
    }

    await tx.workstationPairing.update({ where: { id: pairing.id }, data: { workstationId: workstation.id } });

    // Agent nije zaposleni — bez AuthContext-a, direktan upis u AuditLog
    // (isti dokumentovani izuzetak kao registerPersonalDevice u
    // device-service.ts). NIKAD ne upisuje sirov credential.
    await tx.auditLog.create({
      data: {
        restaurantId: pairing.restaurantId,
        locationId: pairing.locationId,
        action: "workstation.paired",
        entityType: "Workstation",
        entityId: workstation.id,
        newValue: { station: pairing.station, pairingId: pairing.id },
        severity: "INFO",
      },
    });

    return {
      workstationId: workstation.id,
      credential: rawCredential,
      restaurantId: workstation.restaurantId,
      locationId: workstation.locationId,
      station: workstation.station,
      name: workstation.name,
    };
  });
}

const HEARTBEAT_THROTTLE_MS = 30_000;

export interface HeartbeatResult {
  // Faza 2C — agent proverava ovo na SVAKOM heartbeat-u (isti ciklus kao
  // postojeći poll, bez novog endpoint-a) i, ako je true, lokalno štampa
  // testni tiket pa prijavljuje ishod preko recordTestPrintResult iznad.
  testPrintRequested: boolean;
  // Printing V2 — koju rutu da agent testira (bira odgovarajući štampač iz
  // SVOJE lokalne Routes liste po ovom tipu); null kad testPrintRequested
  // je false, ili (odbrambeno) ako je testPrintStatus PENDING bez ikad
  // postavljenog tipa (stariji red pre ove izmene).
  testPrintRoute: PrintRouteType | null;
}

/**
 * Kapacitet/verzija podaci (retki, namerni) se UVEK upisuju odmah, bez
 * throttling-a, i usput osvežavaju lastSeen. Goli heartbeat (bez podataka
 * — buduća Faza 2B: učestalo pollovanje) koristi throttled uslovan upis da
 * ne postane write-amplification problem (zahtev specifikacije).
 */
export async function recordHeartbeat(wsCtx: WorkstationAuthContext, input: WorkstationHeartbeatInput): Promise<HeartbeatResult> {
  const parsed = workstationHeartbeatSchema.parse(input);
  const now = new Date();

  const capabilityData: Prisma.WorkstationUpdateInput = {};
  if (parsed.agentVersion !== undefined) capabilityData.agentVersion = parsed.agentVersion;
  if (parsed.osDescription !== undefined) capabilityData.osDescription = parsed.osDescription;
  // DEPRECATED single-printer fields — kept for older agent builds only.
  if (parsed.configuredPrinterName !== undefined) capabilityData.configuredPrinterName = parsed.configuredPrinterName;
  if (parsed.paperWidthMm !== undefined) capabilityData.paperWidthMm = parsed.paperWidthMm;
  if (parsed.printerAvailable !== undefined) capabilityData.printerAvailable = parsed.printerAvailable;
  // Printing V2 — pun spisak štampača te mašine (Admin dropdown izvor).
  if (parsed.availablePrinters !== undefined) {
    capabilityData.availablePrinters = parsed.availablePrinters;
    capabilityData.printersReportedAt = now;
  }

  if (Object.keys(capabilityData).length > 0) {
    await prisma.workstation.updateMany({
      where: { id: wsCtx.workstationId },
      data: { ...capabilityData, lastSeenAt: now, lastSuccessfulCommunicationAt: now },
    });
  } else {
    await prisma.workstation.updateMany({
      where: {
        id: wsCtx.workstationId,
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(now.getTime() - HEARTBEAT_THROTTLE_MS) } }],
      },
      data: { lastSeenAt: now, lastSuccessfulCommunicationAt: now },
    });
  }

  // Printing V2 — per-route printer availability (a single Workstation-level
  // boolean no longer suffices once one Agent can have several printers).
  // Best-effort, one small update per reported route; never blocks the
  // heartbeat's own success on a route that doesn't exist (e.g. Admin
  // removed it between polls).
  if (parsed.routes?.length) {
    for (const route of parsed.routes) {
      await prisma.workstationPrintRoute
        .updateMany({
          where: { workstationId: wsCtx.workstationId, type: route.type },
          data: { printerAvailable: route.printerAvailable },
        })
        .catch(() => {});
    }
  }

  const current = await prisma.workstation.findUnique({
    where: { id: wsCtx.workstationId },
    select: { testPrintStatus: true, testPrintRouteType: true },
  });
  const pending = current?.testPrintStatus === "PENDING";
  return { testPrintRequested: pending, testPrintRoute: pending ? (current?.testPrintRouteType ?? null) : null };
}

/**
 * Izdvojeno iz recordHeartbeat-a iznad (ISTA logika: testPrintStatus ===
 * "PENDING") da bi /api/agent/poll mogao da nosi isti signal na SVOM,
 * mnogo bržem ciklusu (1-3s, vidi AgentRunner.cs ActivePollMs) umesto da
 * Test Print čeka do 25s heartbeat-a (dokazan uzrok ~19s kašnjenja u
 * PREPROD fizičkom testu). NAMERNO zasebna, minimalna funkcija — ne menja
 * pollAndClaim (agent-print-service.ts) niti njegov povratni tip, koji
 * postojeći integration testovi (agent-print-delivery.test.ts) već
 * pretpostavljaju nepromenjenim. Pozivalac (poll rute) kombinuje oba
 * rezultata u jedan JSON odgovor.
 */
export async function isTestPrintPending(wsCtx: WorkstationAuthContext): Promise<{ pending: boolean; route: PrintRouteType | null }> {
  const current = await prisma.workstation.findUnique({
    where: { id: wsCtx.workstationId },
    select: { testPrintStatus: true, testPrintRouteType: true },
  });
  const pending = current?.testPrintStatus === "PENDING";
  return { pending, route: pending ? (current?.testPrintRouteType ?? null) : null };
}

export interface AgentRoute {
  type: PrintRouteType;
  printerName: string;
  paperWidthMm: number;
}

/**
 * Printing V2 — server-authoritative rute za OVU autentifikovanu radnu
 * stanicu, piggyback-ovano na postojeći poll/heartbeat ciklus (bez novog
 * endpoint-a). Vraća SAMO potpuno podešene, omogućene rute (printerName I
 * paperWidthMm obavezno postavljeni) — agent lokalno čuva TAČNO ovaj spisak
 * (agent.config.json), nikad polu-podešenu rutu bez štampača (Setup više ne
 * bira rute, samo ih prikazuje/testira). Kad Admin promeni/ukloni/onemogući
 * rutu, sledeći poll/heartbeat automatski nosi novo stanje — nema potrebe
 * za novim uparivanjem niti ručnim restartom agenta.
 */
export async function getAgentRoutes(wsCtx: WorkstationAuthContext): Promise<AgentRoute[]> {
  const routes = await prisma.workstationPrintRoute.findMany({
    where: { workstationId: wsCtx.workstationId, isEnabled: true, printerName: { not: null }, paperWidthMm: { not: null } },
    select: { type: true, printerName: true, paperWidthMm: true },
    orderBy: { type: "asc" },
  });
  return routes.map((r) => ({ type: r.type as PrintRouteType, printerName: r.printerName!, paperWidthMm: r.paperWidthMm! }));
}
