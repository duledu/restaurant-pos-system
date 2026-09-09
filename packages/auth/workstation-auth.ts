/**
 * Faza 2A — identitet TableCore Print Agent radne stanice (Windows proces,
 * NE zaposleni/browser sesija). Namerno ODVOJEN tok od requireAuth/AuthContext
 * u rbac.ts — radna stanica nema userId/employeeId/roles/permissions, samo
 * restaurantId/locationId/station izvedene iz sopstvenog trajnog kredencijala.
 *
 * KLJUČNO PRAVILO (isto kao rbac.ts): agent NIKAD ne sme sam da tvrdi
 * restaurantId/locationId — server ih ISKLJUČIVO izvodi iz kredencijala
 * (Authorization: Bearer <token> -> workstations red preko heš pretrage).
 */

import { createHash, randomBytes } from "crypto";

export class WorkstationUnauthorizedError extends Error {
  constructor(message = "Nevažeći ili opozvan kredencijal radne stanice") {
    super(message);
    this.name = "WorkstationUnauthorizedError";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TRAJNI BEARER KREDENCIJAL RADNE STANICE
//
// FORMAT/VERZIJA v1 (WORKSTATION_CREDENTIAL_VERSION, čuva se i u
// Workstation.credentialVersion radi budućih izmena bez lomljenja starih
// kredencijala): prefiks "tcpa1_" + 32 bajta (256 bitova) kriptografski
// slučajne entropije, base64url enkodovano (~43 znaka) -> ukupno ~49 znakova,
// npr. "tcpa1_9f2K3zQ8mN...". Prefiks je isključivo radi prepoznatljivosti
// (isti obrazac kao "sk_live_"/"ghp_" kod drugih provajdera), ne nosi
// entropiju sam po sebi.
//
// NAMERNO SHA-256 (ne scrypt kao PIN/lozinka u pin-auth.ts/password-auth.ts):
// scrypt postoji da uspori brute-force protiv NISKOENTROPIJSKIH, ljudski
// biranih tajni (4-cifreni PIN, kratka lozinka). Ovde je sirova tajna VEĆ
// 256 bitova kriptografski slučajne entropije — potpuno neranjiva na
// brute-force bez obzira na brzinu heš funkcije, pa bi scrypt ovde bio samo
// nepotreban CPU trošak (i realan DoS rizik na heartbeat endpoint-u pri
// učestalim pozivima) bez ijedne bezbednosne dobiti. SHA-256 je NAMERNO
// determinističan (bez soli) jer mora da služi i kao INDEKSIRAN ključ za
// direktnu pretragu (workstations.credentialHash je @unique) — isti obrazac
// koriste GitHub/Stripe/AWS za API ključeve visoke entropije. Sirov
// kredencijal se NIKAD ne loguje niti čuva na serveru posle generisanja —
// samo ovaj heš.
export const WORKSTATION_CREDENTIAL_PREFIX = "tcpa1_";
export const WORKSTATION_CREDENTIAL_VERSION = 1;

export function generateWorkstationCredential(): string {
  return `${WORKSTATION_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashWorkstationCredential(rawCredential: string): string {
  return createHash("sha256").update(rawCredential).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────
// KRATKOTRAJAN, JEDNOKRATAN KOD ZA UPARIVANJE
//
// Crockford Base32 alfabet (32 znaka = tačno 2^5 -> maskiranje donjih 5
// bita slučajnog bajta je savršeno ravnomerno, BEZ modulo pristrasnosti;
// bez rejection sampling-a). Namerno bez I/L/O/U — dvosmisleno pri ručnom
// prepisivanju (I/1, L/1, O/0) ili slučajno nepristojno (U). 12 znakova ->
// 60 bitova entropije, grupisano "XXXX-XXXX-XXXX" radi čitljivosti. I dalje
// se čuva ISKLJUČIVO heš (SHA-256, isti razlog kao gore — kod je
// server-generisan, visoke entropije, ne ljudski biran) — sirov kod se
// vraća SAMO u odgovoru na kreiranje uparivanja, nikad više čitljiv iz baze
// (test zahtev: "no persistent secret stored plaintext server-side").
// Brute-force dodatno ograničen throttling-om na strani rute koja ga troši
// (vidi apps/web/lib/login-throttle.ts, ponovo iskorišćeno pod "pairing:"
// prefiksom ključa).
const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_CODE_LENGTH = 12;
const PAIRING_CODE_GROUP_SIZE = 4;

export function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let raw = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    raw += PAIRING_CODE_ALPHABET[bytes[i] & 0x1f];
  }
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += PAIRING_CODE_GROUP_SIZE) {
    groups.push(raw.slice(i, i + PAIRING_CODE_GROUP_SIZE));
  }
  return groups.join("-");
}

/** Prihvata kod bez obzira na velika/mala slova ili crtice (kopiranje iz
 * agent UI-ja, ručni unos) pre heš-a/poređenja. */
export function normalizePairingCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(normalizePairingCode(code)).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────
// AUTENTIFIKACIJA AGENT ZAHTEVA
// ─────────────────────────────────────────────────────────────────────────

export type WorkstationStationValue = "KITCHEN" | "BAR";

export interface WorkstationAuthContext {
  workstationId: string;
  restaurantId: string;
  locationId: string;
  station: WorkstationStationValue;
}

const BEARER_PREFIX = "Bearer ";

/** Čista (bez I/O) ekstrakcija — testabilna bez baze. */
export function extractWorkstationBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Učitava i validira radnu stanicu iz Authorization: Bearer zaglavlja.
 * Jedina funkcija u sistemu koja sme da konstruiše WorkstationAuthContext —
 * svaki /api/agent/* route handler MORA proći kroz nju (isto pravilo kao
 * requireAuth/AuthContext u rbac.ts).
 *
 * Odbačen kredencijal (nepostojeći, opozvan `revokedAt`, onemogućen
 * `isEnabled=false`) daje ISTU generičku grešku — poruka nikad ne otkriva
 * koji od ta tri razloga je u pitanju (sprečava enumeraciju validnih
 * kredencijala/stanja preko razlike u odgovoru).
 */
export async function requireWorkstationAuth(request: Request): Promise<WorkstationAuthContext> {
  // Dinamički import da fajl ostane upotrebljiv u kontekstima bez Prisma
  // client-a (isti obrazac kao requireAuth u rbac.ts).
  const { prisma } = await import("@rcs/db");

  const token = extractWorkstationBearerToken(request);
  if (!token) {
    throw new WorkstationUnauthorizedError("Nedostaje Authorization: Bearer zaglavlje");
  }

  const credentialHash = hashWorkstationCredential(token);
  const workstation = await prisma.workstation.findUnique({
    where: { credentialHash },
    select: { id: true, restaurantId: true, locationId: true, station: true, isEnabled: true, revokedAt: true },
  });

  if (!workstation || !workstation.isEnabled || workstation.revokedAt) {
    throw new WorkstationUnauthorizedError();
  }

  return {
    workstationId: workstation.id,
    restaurantId: workstation.restaurantId,
    locationId: workstation.locationId,
    station: workstation.station,
  };
}
