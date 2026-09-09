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
  type CreateWorkstationPairingInput,
  type ConsumeWorkstationPairingInput,
  type WorkstationHeartbeatInput,
  type AgentTestPrintResultInput,
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
  agentVersion: true,
  osDescription: true,
  isEnabled: true,
  lastSeenAt: true,
  lastSuccessfulCommunicationAt: true,
  lastPrintAt: true,
  testPrintRequestedAt: true,
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
  station: "KITCHEN" | "BAR";
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
 * Faza 2C — Admin "Test Print" dugme. Namerno NE kreira PrintJob/Order
 * (test štampa ne sme dotaći accounting/izveštaje) — samo postavlja
 * zastavicu na Workstation red koju agent vidi kroz SLEDEĆI heartbeat
 * (recordHeartbeat ispod vraća testPrintRequested) i lokalno štampa preko
 * WindowsPrinter.Print, van AgentRunner/AgentDatabase puta za prave tikete.
 * Idempotentno na uzastopne klikove dok je prethodni zahtev još PENDING —
 * jednostavno ponovo postavlja isto stanje (agent štampa najviše jednom po
 * heartbeat ciklusu u kom primeti zastavicu, ne akumulira duple zahteve).
 */
export async function requestTestPrint(ctx: AuthContext, workstationId: string) {
  requirePermission(ctx, WORKSTATIONS_MANAGE);

  const workstation = await prisma.workstation.findFirst({
    where: { id: workstationId, ...scopeToRestaurant(ctx) },
    select: { id: true, locationId: true, revokedAt: true, isEnabled: true },
  });
  if (!workstation) throw new Error("Radna stanica nije pronađena");
  if (workstation.revokedAt || !workstation.isEnabled) {
    throw new Error("Radna stanica je opozvana ili onemogućena — test štampa nije moguća");
  }

  const now = new Date();
  const updated = await prisma.workstation.update({
    where: { id: workstationId },
    data: {
      testPrintRequestedAt: now,
      testPrintRequestedBy: ctx.employeeId,
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
    // Interna pilot oznaka — MORA se poklapati sa AgentVersion.Current u
    // apps/print-agent/AgentRunner.cs i MyAppVersion u installer/
    // TableCorePrintAgent.iss. NE javno stabilno izdanje.
    version: "1.0.0-pilot.1",
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
  station: "KITCHEN" | "BAR";
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
        name: pairing.name?.trim() || `Radna stanica — ${pairing.station}`,
        credentialHash,
        credentialVersion: WORKSTATION_CREDENTIAL_VERSION,
        agentVersion: parsed.agentVersion,
        osDescription: parsed.osDescription,
        pairedAt: now,
      },
    });

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
  if (parsed.configuredPrinterName !== undefined) capabilityData.configuredPrinterName = parsed.configuredPrinterName;
  if (parsed.paperWidthMm !== undefined) capabilityData.paperWidthMm = parsed.paperWidthMm;
  if (parsed.printerAvailable !== undefined) capabilityData.printerAvailable = parsed.printerAvailable;

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

  const current = await prisma.workstation.findUnique({
    where: { id: wsCtx.workstationId },
    select: { testPrintStatus: true },
  });
  return { testPrintRequested: current?.testPrintStatus === "PENDING" };
}
