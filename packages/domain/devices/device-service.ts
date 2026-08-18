import { prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant, verifyPassword, normalizeEmail, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import type { RegisterDeviceInput } from "@rcs/shared";

const DEVICES_MANAGE = "devices.manage";

export async function listAssignableLocations(ctx: AuthContext) {
  requirePermission(ctx, DEVICES_MANAGE);
  if (ctx.locationIds.length === 0) return [];
  return prisma.location.findMany({
    where: { restaurantId: ctx.restaurantId, id: { in: ctx.locationIds } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Registruje NOV Device red za browser koji poziva ovu rutu — svaki poziv
 * pravi novi red (namerno, ne "find or create"): svaki fizički
 * telefon/tablet/POS terminal dobija sopstveni deviceId koji čuva u
 * localStorage-u, isto kao što svaki zaposleni ima sopstveni PIN. Ovo je
 * jedini gate za PIN prijavu (pin-login/route.ts) — mora biti autentifikovana
 * akcija (requirePermission), da nasumičan uređaj ne može sam sebe upisati.
 */
export async function registerDevice(ctx: AuthContext, input: RegisterDeviceInput) {
  requirePermission(ctx, DEVICES_MANAGE);
  const location = await prisma.location.findFirst({
    where: { id: input.locationId, ...scopeToRestaurant(ctx) },
  });
  if (!location) {
    throw new Error("Lokacija ne pripada ovom restoranu");
  }
  if (!ctx.locationIds.includes(location.id)) {
    throw new Error("Nemaš pristup ovoj lokaciji");
  }

  const device = await prisma.$transaction(async (tx) => {
    const created = await tx.device.create({
      data: {
        restaurantId: ctx.restaurantId,
        locationId: location.id,
        name: `POS terminal — ${location.name}`,
        deviceType: "POS",
      },
    });
    await recordAuditEntry(
      ctx,
      {
        entityType: "Device",
        entityId: created.id,
        action: "device.registered",
        newValue: { locationId: location.id },
        locationId: location.id,
      },
      tx
    );
    return created;
  });

  return device;
}

export interface StaffDirectoryEntry {
  id: string;
  name: string;
  role: string | null;
}

/**
 * Lista zaposlenih za "Zaposleni" selektor na /login — namerno JEDINA
 * funkcija u ovom modulu koja NE prima AuthContext: poziva se PRE
 * autentifikacije (nema sesije), sa istog ekrana koji potom šalje PIN. Zato
 * NIJE globalni direktorijum zaposlenih — opseg se izvodi isključivo iz
 * `deviceId`, koji sme da postoji u browseru samo ako je uređaj već
 * registrovan kroz autentifikovan /device-setup tok (registerDevice iznad).
 * Isti princip kao anonimni PIN login (pin-login/route.ts): deviceId je
 * jedina poverljiva granica pre PIN-a, restaurantId/locationId se NIKAD ne
 * uzimaju direktno od klijenta.
 *
 * Vraća SAMO ono što je potrebno za prikaz izbora (ime, rola) — bez email-a,
 * pinHash-a, failedPinAttempts, pinLockedUntil, userId-a ili druge interne
 * evidencije. Vraća samo AKTIVNE zaposlene koji uopšte imaju PIN (isti
 * uslov koji anonimni PIN login već primenjuje) — OWNER/ADMIN po pravilu
 * nemaju PIN pa se prirodno ne pojavljuju ovde, bez potrebe za posebnom
 * listom dozvoljenih rola koja bi mogla da se raziđe od Staff Management-a.
 *
 * Ako je `device.employeeId` postavljen (LIČNI uređaj), vraća SAMO tog
 * zaposlenog — imenik se ne prikazuje. Deaktiviran zaposleni → null (403).
 *
 * Vraća `null` ako uređaj nije registrovan/aktivan — poziva se pre PIN-a pa
 * ruta ovo mapira na 403, isto kao pin-login.
 */
export async function listStaffForDevice(deviceId: string): Promise<StaffDirectoryEntry[] | null> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device || !device.isActive) return null;

  // Lični uređaj — prikaži SAMO vlasnika uređaja (ne ceo imenik)
  if (device.employeeId) {
    const employee = await prisma.employee.findUnique({
      where: { id: device.employeeId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        pinHash: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    // Deaktiviran zaposleni ili bez PIN-a → ne može se prijaviti
    if (!employee || employee.status !== "ACTIVE" || !employee.pinHash) return null;
    return [
      {
        id: employee.id,
        name: `${employee.firstName} ${employee.lastName}`.trim(),
        role: employee.roles[0]?.role.name ?? null,
      },
    ];
  }

  // Deljeni terminal — vrati sve aktivne zaposlene sa PIN-om za tu lokaciju
  const employees = await prisma.employee.findMany({
    where: {
      restaurantId: device.restaurantId,
      status: "ACTIVE",
      pinHash: { not: null },
      ...(device.locationId ? { locations: { some: { locationId: device.locationId } } } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      roles: { select: { role: { select: { name: true } } } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  return employees.map((e) => ({
    id: e.id,
    name: `${e.firstName} ${e.lastName}`.trim(),
    role: e.roles[0]?.role.name ?? null,
  }));
}

/**
 * Registracija LIČNOG uređaja — zaposleni se identifikuje sopstvenim
 * email+lozinkom (postavljenim od strane admina), bez aktivne sesije.
 *
 * Bezbednost:
 * - Ne prima restaurantId/locationId od klijenta — sve se izvodi iz
 *   verifikovanog naloga zaposlenog.
 * - Ako zaposleni već ima registrovan lični uređaj, stari se deaktivira
 *   (pristup sa prethodnog telefona se odmah blokira — sledeći PIN pokušaj
 *   vraća 403 jer device.isActive = false).
 * - Deaktiviran/suspendovan zaposleni ne može registrovati uređaj.
 * - Audit zapis prati registraciju (bez lozinke/PIN-a u logu).
 *
 * Vraća: { deviceId: string } — klijent čuva u localStorage (isti mehanizam
 * kao kod deljenog terminala).
 */
export async function registerPersonalDevice(params: { email: string; password: string }): Promise<{ deviceId: string; employeeName: string }> {
  const email = normalizeEmail(params.email);

  // Učitaj User + Employee + Restaurant scoped
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      employee: {
        include: {
          restaurant: { select: { id: true, status: true } },
          locations: { select: { locationId: true }, orderBy: { locationId: "asc" } },
        },
      },
    },
  });

  const GENERIC = "Neispravan email ili lozinka";
  if (!user || !user.passwordHash || !user.isActive) throw new Error(GENERIC);

  const passwordOk = await verifyPassword(params.password, user.passwordHash);
  if (!passwordOk) throw new Error(GENERIC);

  const employee = user.employee;
  if (!employee) throw new Error(GENERIC);
  if (employee.status !== "ACTIVE") throw new Error("Nalog zaposlenog nije aktivan");
  if (employee.restaurant.status !== "ACTIVE") throw new Error("Restoran nije aktivan");

  // Izaberi prvu lokaciju zaposlenog (za locationId na uređaju)
  const primaryLocationId = employee.locations[0]?.locationId ?? null;

  const device = await prisma.$transaction(async (tx) => {
    // Deaktiviraj stari lični uređaj ako postoji — employeeId se nullira
    // da bi novi uređaj mogao preuzeti tu vezу (unique constraint).
    const existing = await tx.device.findUnique({ where: { employeeId: employee.id } });
    if (existing) {
      await tx.device.update({ where: { id: existing.id }, data: { isActive: false, employeeId: null } });
    }

    const created = await tx.device.create({
      data: {
        restaurantId: employee.restaurantId,
        locationId: primaryLocationId,
        employeeId: employee.id,
        name: `Lični uređaj — ${employee.firstName} ${employee.lastName}`,
        deviceType: "POS",
        isActive: true,
      },
    });

    // Audit zapis bez lozinke — samo činjenica registracije
    await tx.auditLog.create({
      data: {
        restaurantId: employee.restaurantId,
        userId: employee.id,
        role: null,
        action: "device.personal_registered",
        entityType: "Device",
        entityId: created.id,
        newValue: { employeeId: employee.id, locationId: primaryLocationId },
        severity: "INFO",
        isSuspicious: false,
        locationId: primaryLocationId,
      },
    });

    return created;
  });

  return {
    deviceId: device.id,
    employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
  };
}
