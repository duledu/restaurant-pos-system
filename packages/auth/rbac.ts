/**
 * RBAC + Tenant Scoping middleware
 *
 * KLJUČNO PRAVILO: svaki server-side poziv koji dotiče poslovne podatke MORA
 * proći kroz requireAuth() da bi dobio proveren AuthContext. Nijedan route
 * handler ne sme direktno čitati restaurantId iz request body-ja/query-ja
 * kao izvor istine za autorizaciju — restaurantId iz konteksta (izveden iz
 * sesije/tokena) je jedini pouzdan izvor.
 */

export interface AuthContext {
  userId: string;
  employeeId: string;
  restaurantId: string;
  locationIds: string[];
  roles: string[];
  permissions: Set<string>;
  deviceId?: string;
}

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface ActiveSessionEntities {
  employeeStatus: string;
  userIsActive: boolean | null;
  allowMissingUser?: boolean;
  restaurantStatus: string;
  tenantStatus: string;
}

export function assertActiveSessionEntities(entities: ActiveSessionEntities): void {
  if (entities.employeeStatus !== "ACTIVE") {
    throw new UnauthorizedError("Nalog zaposlenog nije aktivan");
  }
  if (entities.userIsActive === false) {
    throw new UnauthorizedError("Korisnički nalog nije aktivan");
  }
  if (entities.userIsActive === null && !entities.allowMissingUser) {
    throw new UnauthorizedError("Korisnički nalog više ne postoji");
  }
  if (entities.restaurantStatus !== "ACTIVE") {
    throw new UnauthorizedError("Restoran nije aktivan");
  }
  if (entities.tenantStatus !== "ACTIVE") {
    throw new UnauthorizedError("Tenant nije aktivan");
  }
}

export interface DeviceSessionEntity {
  restaurantId: string;
  isActive: boolean;
  lastSeenAt: Date | null;
}

/**
 * Zatvara bezbednosnu rupu otkrivenu pri Admin Device Management istrazi:
 * requireAuth ranije NIKAD nije proveravao Device.isActive — opoziv uređaja
 * je blokirao NOVE PIN prijave (pin-login.ts), ali VEĆ IZDAT session token
 * je i dalje radio do isteka (12h). Ova provera se primenjuje SAMO kad
 * sesija uopšte nosi deviceId (Shared POS/Staff Device tok) — sesije bez
 * deviceId-a (email/lozinka admin prijava) prolaze nepromenjeno, isto kao
 * pre ove izmene.
 *
 * NIKAD ne utiče na rolu/permisije — to ostaje isključivo iz employee.roles
 * (specifikacija: "device identity must NOT determine employee role").
 * TypeScript assertion signature sužava `device` posle poziva bez `!`.
 */
export function assertActiveDevice(
  device: DeviceSessionEntity | null,
  expectedRestaurantId: string
): asserts device is DeviceSessionEntity {
  if (!device || device.restaurantId !== expectedRestaurantId || !device.isActive) {
    throw new UnauthorizedError("Uređaj nije aktivan ili nije registrovan");
  }
}

const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Odlučuje da li je vreme za novi lastSeenAt upis — namerno "best effort"
 * throttling (specifikacija: "Do NOT write lastSeenAt on every authenticated
 * API request"), ne tačan heartbeat. Čista funkcija radi jedinične
 * testabilnosti bez baze/sata.
 */
export function shouldRefreshLastSeen(lastSeenAt: Date | null, now: Date = new Date()): boolean {
  if (!lastSeenAt) return true;
  return now.getTime() - lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS;
}

/**
 * Učitava i validira sesiju iz cookie-ja, zatim učitava SVEŽE role/permission
 * i dozvoljene lokacije iz baze (nikad iz JWT payload-a — vidi napomenu u
 * session.ts). Ovo je jedina funkcija u sistemu koja sme da konstruiše
 * AuthContext; svaki route handler mora proći kroz nju (direktno ili preko
 * withAuth wrappera ispod).
 */
export async function requireAuth(request: Request): Promise<AuthContext> {
  // Dinamički import da rbac.ts ostane upotrebljiv i u kontekstima bez
  // Prisma client-a (npr. unit testovi čistih funkcija ispod).
  const { prisma } = await import("@rcs/db");
  const { verifySessionToken } = await import("./session");

  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/rcs_session=([^;]+)/);
  if (!match) {
    throw new UnauthorizedError("Nema aktivne sesije");
  }

  const session = await verifySessionToken(decodeURIComponent(match[1]));
  if (!session) {
    throw new UnauthorizedError("Sesija je nevalidna ili istekla");
  }

  // Employee i Device se učitavaju PARALELNO (Promise.all) — ne sekvencijalno
  // — da provera opozvanog uređaja ne doda merljivu dodatnu latenciju na
  // svaki autentifikovan zahtev sa deviceId-jem (Waiter/KDS/Shared POS su
  // veliki deo saobraćaja). Device upit se uopšte ne šalje kad sesija nema
  // deviceId (email/lozinka admin sesije) — nula dodatnih upita za taj slučaj.
  const [employee, device] = await Promise.all([
    prisma.employee.findUnique({
      where: { id: session.employeeId },
      include: {
        user: { select: { isActive: true } },
        restaurant: {
          select: {
            status: true,
            tenant: { select: { status: true } },
          },
        },
        locations: { select: { locationId: true } },
        roles: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        },
      },
    }),
    session.deviceId
      ? prisma.device.findUnique({
          where: { id: session.deviceId },
          select: { restaurantId: true, isActive: true, lastSeenAt: true },
        })
      : Promise.resolve(null),
  ]);

  if (!employee || employee.restaurantId !== session.restaurantId) {
    throw new UnauthorizedError("Nalog zaposlenog nije aktivan ili ne odgovara sesiji");
  }

  assertActiveSessionEntities({
    employeeStatus: employee.status,
    userIsActive: employee.user?.isActive ?? null,
    allowMissingUser: Boolean(session.deviceId),
    restaurantStatus: employee.restaurant.status,
    tenantStatus: employee.restaurant.tenant.status,
  });

  if (session.deviceId) {
    assertActiveDevice(device, session.restaurantId);

    // Best-effort throttled aktivnost — vidi shouldRefreshLastSeen. Greška
    // ovde NIKAD ne sme oboriti stvaran (poslovni) zahtev koji je već
    // prošao sve bezbednosne provere iznad.
    if (shouldRefreshLastSeen(device.lastSeenAt)) {
      try {
        await prisma.device.update({ where: { id: session.deviceId }, data: { lastSeenAt: new Date() } });
      } catch {
        // Namerno progutano — lastSeenAt je isključivo informativno.
      }
    }
  }

  const roles = employee.roles.map((er) => er.role.name);
  const permissions = new Set<string>();
  for (const er of employee.roles) {
    for (const rp of er.role.permissions) {
      permissions.add(rp.permission.code);
    }
  }

  return {
    userId: session.userId,
    employeeId: employee.id,
    restaurantId: employee.restaurantId,
    locationIds: employee.locations.map((l) => l.locationId),
    roles,
    permissions,
    deviceId: session.deviceId,
  };
}

/**
 * Baca ForbiddenError ako trenutni korisnik nema traženu permisiju.
 * Permisije se proveravaju isključivo na serveru — UI sakrivanje dugmeta
 * NIJE zamena za ovu proveru.
 */
export function requirePermission(ctx: AuthContext, permissionCode: string): void {
  if (!ctx.permissions.has(permissionCode)) {
    throw new ForbiddenError(`Missing permission: ${permissionCode}`);
  }
}

/**
 * Baca ForbiddenError ako lokacija na koju se odnosi zahtev nije u listi
 * lokacija na kojima zaposleni sme da radi.
 */
export function requireLocationAccess(ctx: AuthContext, locationId: string): void {
  if (!ctx.locationIds.includes(locationId)) {
    throw new ForbiddenError(`No access to location: ${locationId}`);
  }
}

/**
 * Vraća tenant filter koji MORA biti dodat na svaki Prisma upit prema
 * poslovnim tabelama. Primer upotrebe:
 *
 *   await prisma.order.findMany({ where: { ...scopeToRestaurant(ctx) } })
 */
export function scopeToRestaurant(ctx: AuthContext): { restaurantId: string } {
  return { restaurantId: ctx.restaurantId };
}

/**
 * Wrapper za route handlere koji garantuje da handler ne može biti pozvan
 * bez validnog AuthContext-a i (opciono) bez tražene permisije.
 */
export function withAuth<T>(
  handler: (ctx: AuthContext, request: Request) => Promise<T>,
  options?: { permission?: string }
) {
  return async (request: Request): Promise<T> => {
    const ctx = await requireAuth(request);
    if (options?.permission) {
      requirePermission(ctx, options.permission);
    }
    return handler(ctx, request);
  };
}
