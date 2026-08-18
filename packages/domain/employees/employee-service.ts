import { prisma, type Prisma } from "@rcs/db";
import {
  requirePermission,
  scopeToRestaurant,
  hashPassword,
  normalizeEmail,
  hashPin,
  verifyPin,
  type AuthContext,
} from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import type { CreateEmployeeInput, UpdateEmployeeInput } from "@rcs/shared";

const EMPLOYEES_VIEW = "employees.view";
const EMPLOYEES_MANAGE = "employees.manage";
const EMPLOYEES_MANAGE_PERMISSION_CODE = "employees.manage";

/**
 * Lista zaposlenih restorana. Tenant scoping se sprovodi eksplicitno kroz
 * scopeToRestaurant(ctx) — nijedan upit u ovom modulu ne sme koristiti
 * restaurantId iz bilo kog izvora osim AuthContext-a.
 */
export async function listEmployees(ctx: AuthContext) {
  requirePermission(ctx, EMPLOYEES_VIEW);

  const rows = await prisma.employee.findMany({
    where: scopeToRestaurant(ctx),
    include: {
      roles: { include: { role: true } },
      locations: { include: { location: true } },
      user: { select: { id: true, passwordHash: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // pinHash/failedPinAttempts/pinLockedUntil i user.passwordHash su interna
  // bezbednosna knjigovodstva — nikad se ne šalju klijentu, čak ni kao heš.
  // Klijent dobija samo binarne zastavice da li PIN/login nalog postoji.
  return rows.map(({ pinHash, failedPinAttempts, pinLockedUntil, user, ...rest }) => ({
    ...rest,
    hasPin: pinHash !== null,
    hasLoginCredentials: Boolean(user?.passwordHash),
  }));
}

/** Lokacije koje admin sme da dodeli zaposlenom — skopirano na ctx.locationIds,
 * NIKAD ceo restoran (ista logika kao reporting.listAccessibleLocations, ali
 * pod employees.manage umesto audit.view — različita permisija, različiti
 * pozivaoci, pa nije vredno veštački deljenje jednog upita od 3 reda). */
export async function listAssignableLocations(ctx: AuthContext) {
  requirePermission(ctx, EMPLOYEES_MANAGE);
  if (ctx.locationIds.length === 0) return [];
  return prisma.location.findMany({
    where: { restaurantId: ctx.restaurantId, id: { in: ctx.locationIds } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/**
 * PIN heševi su nasumično soljeni (hashPin generiše nov salt na svaki poziv)
 * — isti PIN "1234" NIKAD ne proizvodi isti hash string dva puta, pa se
 * jedinstvenost NE MOŽE sprovesti preko @unique kolone u bazi (to bi
 * zahtevalo deterministički hash za pretragu, što bi PONOVO uvelo tačno onu
 * ranjivost koju soljeni scrypt hash sprečava — trivijalno rečnik-pretraga
 * 4-6-cifrenog prostora). Umesto toga, PROVERAVAMO tako što VERIFIKUJEMO
 * predloženi PIN protiv hash-a SVAKOG aktivnog zaposlenog restorana —
 * scrypt je namerno spor, ali ovo je retka administrativna radnja (kreiranje
 * zaposlenog, reset PIN-a), ne hot-path, pa je prihvatljivo.
 *
 * Domet jedinstvenosti: PO RESTORANU, samo među AKTIVNIM zaposlenima —
 * deaktiviran zaposleni ne može da se prijavi (status provera u
 * requireAuth/pin-login ruti), pa njegov PIN realno više nije "zauzet".
 */
async function assertPinAvailable(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  pin: string,
  excludeEmployeeId?: string
): Promise<void> {
  const candidates = await tx.employee.findMany({
    where: {
      restaurantId,
      status: "ACTIVE",
      pinHash: { not: null },
      ...(excludeEmployeeId ? { id: { not: excludeEmployeeId } } : {}),
    },
    select: { pinHash: true },
  });
  const matches = await Promise.all(candidates.map((c) => verifyPin(pin, c.pinHash as string)));
  if (matches.some(Boolean)) {
    throw new Error("Ovaj PIN je već dodeljen drugom aktivnom zaposlenom u restoranu — izaberi drugi");
  }
}

/**
 * Advisory lock skopiran po restaurantId — serijalizuje SVAKU proveru+upis
 * PIN-a za ovaj restoran unutar transakcije. Bez ovoga, dva konkurentna
 * zahteva (npr. dva admina istovremeno kreiraju zaposlene sa istim PIN-om)
 * mogu OBA proći proveru jedinstvenosti pre nego što ijedan upiše red —
 * klasičan TOCTOU. `hashtext()` je deterministička ugrađena Postgres
 * funkcija; lock se automatski oslobađa na COMMIT/ROLLBACK transakcije.
 */
async function withPinUniquenessLock<T>(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  fn: () => Promise<T>
): Promise<T> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}))`;
  return fn();
}

async function employeeHasManageCapability(tx: Prisma.TransactionClient, employeeId: string): Promise<boolean> {
  const count = await tx.employeeRole.count({
    where: { employeeId, role: { permissions: { some: { permission: { code: EMPLOYEES_MANAGE_PERMISSION_CODE } } } } },
  });
  return count > 0;
}

async function roleNamesGrantManageCapability(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  roleNames: string[]
): Promise<boolean> {
  const count = await tx.role.count({
    where: { restaurantId, name: { in: roleNames }, permissions: { some: { permission: { code: EMPLOYEES_MANAGE_PERMISSION_CODE } } } },
  });
  return count > 0;
}

/**
 * Sprečava dva opasna stanja restorana (specifikacija #11):
 * 1. Nula aktivnih OWNER naloga.
 * 2. Nula aktivnih naloga koji uopšte mogu da upravljaju osobljem
 *    (employees.manage) — širi slučaj od (1), jer trenutno MANAGER rola
 *    NEMA tu permisiju (vidi seed.ts), pa "OWNER + par MANAGER-a" i dalje
 *    postaje zaključan restoran ako se ukloni jedini OWNER/ADMIN.
 *
 * Primenjuje se JEDNAKO bez obzira da li admin menja SEBE ili nekog drugog
 * — zaključavanje restorana je opasno u oba slučaja, ne samo kad je u
 * pitanju sopstveni nalog.
 */
async function assertSafeManagementChange(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  targetEmployeeId: string,
  changes: { losingOwnerRole: boolean; losingManageCapability: boolean }
): Promise<void> {
  if (changes.losingOwnerRole) {
    const otherOwners = await tx.employee.count({
      where: {
        restaurantId,
        status: "ACTIVE",
        id: { not: targetEmployeeId },
        roles: { some: { role: { name: "OWNER" } } },
      },
    });
    if (otherOwners === 0) {
      throw new Error("Restoran mora imati bar jednog aktivnog vlasnika (OWNER) — ova izmena bi ga uklonila");
    }
  }
  if (changes.losingManageCapability) {
    const otherManagers = await tx.employee.count({
      where: {
        restaurantId,
        status: "ACTIVE",
        id: { not: targetEmployeeId },
        roles: { some: { role: { permissions: { some: { permission: { code: EMPLOYEES_MANAGE_PERMISSION_CODE } } } } } },
      },
    });
    if (otherManagers === 0) {
      throw new Error("Ova izmena bi ostavila restoran bez ijednog naloga koji može da upravlja osobljem");
    }
  }
}

/**
 * Kreira zaposlenog + (opciono) login nalog + role + lokacije u jednoj
 * transakciji. Ako bilo koji korak ne uspe, ništa se ne upisuje.
 */
export async function createEmployee(ctx: AuthContext, input: CreateEmployeeInput) {
  requirePermission(ctx, EMPLOYEES_MANAGE);

  // Sve dozvoljene lokacije za zaposlenog moraju pripadati istom restoranu
  // kao ctx.restaurantId — sprečava curenje lokacija drugog tenant-a kroz
  // input.locationIds.
  const validLocations = await prisma.location.findMany({
    where: { id: { in: input.locationIds }, restaurantId: ctx.restaurantId },
    select: { id: true },
  });
  if (validLocations.length !== input.locationIds.length) {
    throw new Error("Jedna ili više lokacija ne pripadaju ovom restoranu");
  }

  const roles = await prisma.role.findMany({
    where: { restaurantId: ctx.restaurantId, name: { in: input.roleNames } },
  });
  if (roles.length !== input.roleNames.length) {
    throw new Error("Jedna ili više rola nije pronađena za ovaj restoran");
  }

  const passwordHash = input.password ? await hashPassword(input.password) : undefined;
  const pinHash = input.pin ? await hashPin(input.pin) : undefined;

  const employee = await prisma.$transaction(async (tx) => {
    if (input.pin) {
      await withPinUniquenessLock(tx, ctx.restaurantId, () => assertPinAvailable(tx, ctx.restaurantId, input.pin as string));
    }

    let userId: string | undefined;
    if (input.email && passwordHash) {
      const user = await tx.user.create({
        data: { email: normalizeEmail(input.email), passwordHash },
      });
      userId = user.id;
    }

    const created = await tx.employee.create({
      data: {
        restaurantId: ctx.restaurantId,
        userId,
        firstName: input.firstName,
        lastName: input.lastName,
        pinHash,
        createdBy: ctx.employeeId,
      },
    });

    await tx.employeeLocation.createMany({
      data: input.locationIds.map((locationId) => ({ employeeId: created.id, locationId })),
    });

    await tx.employeeRole.createMany({
      data: roles.map((role) => ({ employeeId: created.id, roleId: role.id })),
    });

    await recordAuditEntry(
      ctx,
      {
        entityType: "Employee",
        entityId: created.id,
        action: "employee.created",
        newValue: { firstName: input.firstName, lastName: input.lastName, roleNames: input.roleNames, locationIds: input.locationIds },
      },
      tx
    );

    return created;
  });

  return employee;
}

/**
 * Izmena imena/rola/lokacija postojećeg zaposlenog. Rola/lokacija izmene se
 * primenjuju odmah — requireAuth (rbac.ts) UVEK učitava sveže role/permisije
 * iz baze na svaki zahtev, nikad iz JWT-a, pa aktivna sesija zaposlenog
 * automatski dobija novi skup dozvola na SLEDEĆI poziv, bez posebne
 * "invalidacije sesije" logike (specifikacija #6/#17 — ovo već postoji od
 * Faze 1, ne treba ga graditi ponovo).
 */
export async function updateEmployee(ctx: AuthContext, employeeId: string, input: UpdateEmployeeInput) {
  requirePermission(ctx, EMPLOYEES_MANAGE);

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, ...scopeToRestaurant(ctx) },
    include: { roles: { include: { role: true } }, locations: true },
  });
  if (!employee) throw new Error("Zaposleni nije pronađen");

  let validLocationIds: string[] | undefined;
  if (input.locationIds) {
    const validLocations = await prisma.location.findMany({
      where: { id: { in: input.locationIds }, restaurantId: ctx.restaurantId },
      select: { id: true },
    });
    if (validLocations.length !== input.locationIds.length) {
      throw new Error("Jedna ili više lokacija ne pripadaju ovom restoranu");
    }
    validLocationIds = validLocations.map((l) => l.id);
  }

  let roles: { id: string; name: string }[] | undefined;
  if (input.roleNames) {
    roles = await prisma.role.findMany({ where: { restaurantId: ctx.restaurantId, name: { in: input.roleNames } } });
    if (roles.length !== input.roleNames.length) {
      throw new Error("Jedna ili više rola nije pronađena za ovaj restoran");
    }
  }

  const previousRoleNames = employee.roles.map((r) => r.role.name);
  const previousLocationIds = employee.locations.map((l) => l.locationId);

  const updated = await prisma.$transaction(async (tx) => {
    if (input.roleNames) {
      const losingOwnerRole = previousRoleNames.includes("OWNER") && !input.roleNames.includes("OWNER");
      const hadManageCapability = await employeeHasManageCapability(tx, employeeId);
      const willHaveManageCapability = await roleNamesGrantManageCapability(tx, ctx.restaurantId, input.roleNames);
      await assertSafeManagementChange(tx, ctx.restaurantId, employeeId, {
        losingOwnerRole,
        losingManageCapability: hadManageCapability && !willHaveManageCapability,
      });
    }

    if (input.firstName !== undefined || input.lastName !== undefined) {
      await tx.employee.update({
        where: { id: employeeId },
        data: {
          firstName: input.firstName ?? employee.firstName,
          lastName: input.lastName ?? employee.lastName,
        },
      });
    }
    if (validLocationIds) {
      await tx.employeeLocation.deleteMany({ where: { employeeId } });
      await tx.employeeLocation.createMany({ data: validLocationIds.map((locationId) => ({ employeeId, locationId })) });
    }
    if (roles) {
      await tx.employeeRole.deleteMany({ where: { employeeId } });
      await tx.employeeRole.createMany({ data: roles.map((role) => ({ employeeId, roleId: role.id })) });
    }

    await recordAuditEntry(
      ctx,
      {
        entityType: "Employee",
        entityId: employeeId,
        action: "employee.updated",
        previousValue: { firstName: employee.firstName, lastName: employee.lastName, roleNames: previousRoleNames, locationIds: previousLocationIds },
        newValue: {
          firstName: input.firstName ?? employee.firstName,
          lastName: input.lastName ?? employee.lastName,
          roleNames: input.roleNames ?? previousRoleNames,
          locationIds: validLocationIds ?? previousLocationIds,
        },
      },
      tx
    );

    return tx.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: { roles: { include: { role: true } }, locations: { include: { location: true } } },
    });
  });

  return updated;
}

/**
 * Reset PIN-a — koristi ISTI hashPin (scrypt, nasumično soljen) mehanizam
 * kao Faza 1. Takođe čisti failedPinAttempts/pinLockedUntil (razuman admin
 * tok: zaposleni je zaključan zbog zaboravljenog PIN-a, admin dodeljuje nov
 * i on odmah radi, bez čekanja na istek zaključavanja).
 *
 * AuditLog zapis NIKAD ne sadrži PIN — ni plain tekst ni heš (specifikacija
 * #7/#13). Samo činjenica DA se desilo.
 */
export async function resetEmployeePin(ctx: AuthContext, employeeId: string, newPin: string) {
  requirePermission(ctx, EMPLOYEES_MANAGE);

  const employee = await prisma.employee.findFirst({ where: { id: employeeId, ...scopeToRestaurant(ctx) } });
  if (!employee) throw new Error("Zaposleni nije pronađen");

  const pinHash = await hashPin(newPin);

  await prisma.$transaction(async (tx) => {
    await withPinUniquenessLock(tx, ctx.restaurantId, () => assertPinAvailable(tx, ctx.restaurantId, newPin, employeeId));

    await tx.employee.update({
      where: { id: employeeId },
      data: { pinHash, failedPinAttempts: 0, pinLockedUntil: null },
    });

    await recordAuditEntry(
      ctx,
      {
        entityType: "Employee",
        entityId: employeeId,
        action: "employee.pin_reset",
      },
      tx
    );
  });
}

/**
 * Aktivacija/deaktivacija — NIKAD fizičko brisanje (specifikacija #8/#19).
 * Deaktivacija odmah blokira PIN i email prijavu (status provera u
 * requireAuth/login rutama) i uklanja zaposlenog iz normalne liste aktivnog
 * osoblja, ali istorijski redovi (Order.openedBy, Payment.completedBy,
 * Shift.openedBy/closedBy, OrderItemVoid.voidedBy, AuditLog.userId) ostaju
 * netaknuti — ništa od ovoga ne referencira Employee preko FK-a koji bi
 * kaskadno obrisao (namerna arhitektura od Faze 1, vidi napomene u
 * schema.prisma), pa istorija ostaje čitljiva/tačna zauvek.
 */
/**
 * Admin postavlja ili resetuje lozinku za prijavu zaposlenog.
 *
 * Kreira User nalog ako zaposleni još nema jedan (PIN-only zaposleni koji
 * treba lični uređaj). Ako nalog već postoji, menja hash lozinke.
 *
 * Ograničenja:
 * - Admin NIJE u mogućnosti da pročita trenutnu lozinku (nije stored plain)
 * - Audit zapis ne sadrži ni plain tekst ni hash lozinke
 * - Email mora biti jedinstven u celoj bazi (User.email @unique)
 */
export async function setEmployeeLoginPassword(
  ctx: AuthContext,
  employeeId: string,
  params: { email: string; password: string }
) {
  requirePermission(ctx, EMPLOYEES_MANAGE);

  if (params.password.length < 10) {
    throw new Error("Lozinka mora imati najmanje 10 karaktera");
  }

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, ...scopeToRestaurant(ctx) },
    include: { user: true },
  });
  if (!employee) throw new Error("Zaposleni nije pronađen");

  const email = normalizeEmail(params.email);
  const passwordHash = await hashPassword(params.password);

  await prisma.$transaction(async (tx) => {
    if (employee.user) {
      // Zaposleni već ima User nalog — ažuriraj email i lozinku
      await tx.user.update({
        where: { id: employee.user.id },
        data: { email, passwordHash },
      });
    } else {
      // PIN-only zaposleni — kreiraj User nalog i poveži ga
      const user = await tx.user.create({ data: { email, passwordHash } });
      await tx.employee.update({ where: { id: employeeId }, data: { userId: user.id } });
    }

    await recordAuditEntry(
      ctx,
      {
        entityType: "Employee",
        entityId: employeeId,
        action: "employee.login_credential_set",
        newValue: { email },
      },
      tx
    );
  });
}

export async function setEmployeeStatus(ctx: AuthContext, employeeId: string, status: "ACTIVE" | "SUSPENDED") {
  requirePermission(ctx, EMPLOYEES_MANAGE);

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, ...scopeToRestaurant(ctx) },
    include: { roles: { include: { role: true } } },
  });
  if (!employee) throw new Error("Zaposleni nije pronađen");
  if (employee.status === status) return employee;

  const updated = await prisma.$transaction(async (tx) => {
    if (status === "SUSPENDED") {
      const roleNames = employee.roles.map((r) => r.role.name);
      await assertSafeManagementChange(tx, ctx.restaurantId, employeeId, {
        losingOwnerRole: roleNames.includes("OWNER"),
        losingManageCapability: await employeeHasManageCapability(tx, employeeId),
      });
    }

    const result = await tx.employee.update({ where: { id: employeeId }, data: { status } });

    await recordAuditEntry(
      ctx,
      {
        entityType: "Employee",
        entityId: employeeId,
        action: status === "SUSPENDED" ? "employee.deactivated" : "employee.reactivated",
        previousValue: { status: employee.status },
        newValue: { status },
      },
      tx
    );

    return result;
  });

  return updated;
}
