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
