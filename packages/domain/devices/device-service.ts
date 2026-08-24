import { prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant, verifyPassword, normalizeEmail, type AuthContext } from "@rcs/auth";
import { recordAuditEntry, resolveEmployeeDisplayNames } from "../audit/audit-service";
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

const REGISTRATION_ACTIONS = ["device.registered", "device.personal_registered"];

/**
 * Lista uređaja restorana za Admin Devices ekran. "Ko je registrovao" se
 * IZVODI iz postojećeg AuditLog-a (najraniji device.registered/
 * device.personal_registered zapis po uređaju) — nema posebne kolone za to,
 * u skladu sa "izvedi iz postojećih audit podataka ako je moguće bezbedno".
 * Deljeni POS vs Lični uređaj = employeeId null/not-null (isti obrazac kao
 * registerPersonalDevice/pin-login), ne poseban tip u bazi.
 */
export async function listDevices(ctx: AuthContext) {
  requirePermission(ctx, DEVICES_MANAGE);

  const devices = await prisma.device.findMany({
    where: scopeToRestaurant(ctx),
    include: {
      location: { select: { id: true, name: true } },
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { registeredAt: "desc" },
  });
  if (devices.length === 0) return [];

  const registrationEntries = await prisma.auditLog.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      entityType: "Device",
      entityId: { in: devices.map((d) => d.id) },
      action: { in: REGISTRATION_ACTIONS },
    },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, userId: true },
  });
  const registeredByUserId = new Map<string, string>();
  for (const entry of registrationEntries) {
    // orderBy asc + "ne prepisuj ako već postoji" => čuva NAJRANIJI zapis
    // po uređaju (stvarna registracija, ne kasnija izmena istog tipa akcije).
    if (entry.userId && !registeredByUserId.has(entry.entityId)) {
      registeredByUserId.set(entry.entityId, entry.userId);
    }
  }
  const actorNames = await resolveEmployeeDisplayNames(ctx.restaurantId, [...registeredByUserId.values()]);

  return devices.map((d) => {
    const registeredByUser = registeredByUserId.get(d.id);
    return {
      id: d.id,
      name: d.name,
      deviceType: d.deviceType,
      isShared: d.employeeId === null,
      isActive: d.isActive,
      registeredAt: d.registeredAt,
      lastSeenAt: d.lastSeenAt,
      location: d.location,
      linkedEmployee: d.employee ? { id: d.employee.id, name: `${d.employee.firstName} ${d.employee.lastName}` } : null,
      registeredBy: registeredByUser ? (actorNames.get(registeredByUser)?.name ?? null) : null,
    };
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
        pinLoginEnabled: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    // Deaktiviran zaposleni, bez PIN-a ili PIN prijava onemogućena → ne može se prijaviti
    if (!employee || employee.status !== "ACTIVE" || !employee.pinHash || !employee.pinLoginEnabled) return null;
    return [
      {
        id: employee.id,
        name: `${employee.firstName} ${employee.lastName}`.trim(),
        role: employee.roles[0]?.role.name ?? null,
      },
    ];
  }

  // Deljeni terminal — vrati sve aktivne zaposlene sa PIN-om i omogućenom PIN prijavom
  const employees = await prisma.employee.findMany({
    where: {
      restaurantId: device.restaurantId,
      status: "ACTIVE",
      pinHash: { not: null },
      pinLoginEnabled: true,
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
export async function registerPersonalDevice(params: { username?: string; email?: string; password: string }): Promise<{ deviceId: string; employeeName: string }> {
  const loginName = params.username ?? params.email;
  if (!loginName) throw new Error("Neispravno korisničko ime ili lozinka");
  const username = normalizeEmail(loginName);

  // Učitaj User + Employee + Restaurant scoped
  const user = await prisma.user.findUnique({
    where: { username },
    include: {
      employee: {
        include: {
          restaurant: { select: { id: true, status: true } },
          locations: { select: { locationId: true }, orderBy: { locationId: "asc" } },
        },
      },
    },
  });

  const GENERIC = "Neispravno korisničko ime ili lozinka";
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

/**
 * Preimenovanje ne menja registracionu istovetnost uređaja — ISTI id,
 * registeredAt, isActive, employeeId, restaurantId/locationId ostaju
 * netaknuti. Samo prikazni naziv (name).
 */
export async function renameDevice(ctx: AuthContext, deviceId: string, name: string) {
  requirePermission(ctx, DEVICES_MANAGE);

  const trimmed = name.trim();
  if (!trimmed) throw new Error("Naziv uređaja je obavezan");
  if (trimmed.length > 100) throw new Error("Naziv uređaja je predugačak (max 100 karaktera)");

  const device = await prisma.device.findFirst({ where: { id: deviceId, ...scopeToRestaurant(ctx) } });
  if (!device) throw new Error("Uređaj nije pronađen");

  const updated = await prisma.device.update({ where: { id: deviceId }, data: { name: trimmed } });

  await recordAuditEntry(ctx, {
    entityType: "Device",
    entityId: deviceId,
    action: "device.renamed",
    previousValue: { name: device.name },
    newValue: { name: trimmed },
    locationId: device.locationId ?? undefined,
  });

  return updated;
}

/**
 * Deljena osnova za revokeDevice/reactivateDevice — isti oblik kao
 * employee-service.ts setEmployeeStatus: samo isActive zastavica, uz audit.
 * Idempotentno (no-op ako je uređaj već u traženom stanju) da dupli klik ne
 * pravi duplirane audit zapise. NIKAD ne menja restaurantId/locationId/
 * employeeId/name/registeredAt — isključivo isActive.
 */
async function setDeviceActive(
  ctx: AuthContext,
  deviceId: string,
  isActive: boolean,
  action: "device.revoked" | "device.reactivated"
) {
  requirePermission(ctx, DEVICES_MANAGE);

  const device = await prisma.device.findFirst({ where: { id: deviceId, ...scopeToRestaurant(ctx) } });
  if (!device) throw new Error("Uređaj nije pronađen");
  if (device.isActive === isActive) return device;

  const updated = await prisma.device.update({ where: { id: deviceId }, data: { isActive } });

  await recordAuditEntry(ctx, {
    entityType: "Device",
    entityId: deviceId,
    action,
    previousValue: { isActive: device.isActive },
    newValue: { isActive },
    locationId: device.locationId ?? undefined,
  });

  return updated;
}

/**
 * Opoziva uređaj — blokira NOVE PIN prijave odmah (pin-login.ts već
 * proverava isActive) i, preko requireAuth-ove Device provere (rbac.ts),
 * odbacuje i VEĆ IZDATU sesiju sa ovim deviceId-jem na njen sledeći zahtev.
 * NE briše/menja Employee, role, Orders, Payments, Shifts, Inventory, KDS
 * podatke, niti bilo koji drugi Device.
 */
export async function revokeDevice(ctx: AuthContext, deviceId: string) {
  return setDeviceActive(ctx, deviceId, false, "device.revoked");
}

export async function reactivateDevice(ctx: AuthContext, deviceId: string) {
  return setDeviceActive(ctx, deviceId, true, "device.reactivated");
}
