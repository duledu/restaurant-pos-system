import { prisma } from "@rcs/db";
import { requirePermission, scopeToRestaurant, type AuthContext } from "@rcs/auth";
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
 * Vraća `null` ako uređaj nije registrovan/aktivan — poziva se pre PIN-a pa
 * ruta ovo mapira na 403, isto kao pin-login.
 */
export async function listStaffForDevice(deviceId: string): Promise<StaffDirectoryEntry[] | null> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device || !device.isActive) return null;

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
