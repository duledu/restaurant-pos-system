import { prisma } from "@rcs/db";
import { requirePermission, requireLocationAccess, scopeToRestaurant, type AuthContext } from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import type { OpenShiftInput } from "@rcs/shared";

const SHIFTS_MANAGE = "shifts.manage";

/**
 * Konobar/kuhinja/šank ne smeju raditi bez aktivne smene na svojoj lokaciji
 * (vidi v2 plan, pravilo #6). Ova funkcija je ono što svaki POS/KDS/bar
 * endpoint poziva PRE bilo koje operacije da dobije shiftId.
 */
export async function getActiveShift(ctx: AuthContext, locationId: string) {
  requireLocationAccess(ctx, locationId);
  return prisma.shift.findFirst({
    where: { ...scopeToRestaurant(ctx), locationId, status: "OPEN" },
  });
}

export async function openShift(ctx: AuthContext, input: OpenShiftInput) {
  requirePermission(ctx, SHIFTS_MANAGE);
  requireLocationAccess(ctx, input.locationId);

  const existing = await getActiveShift(ctx, input.locationId);
  if (existing) {
    throw new Error("Već postoji otvorena smena na ovoj lokaciji");
  }

  // Partial unique index (shifts_one_open_per_location) na bazi je
  // KRAJNJA linija odbrane protiv race condition-a (dva konobara otvaraju
  // smenu istovremeno) — ova provera iznad je samo brža, korisniku
  // prijateljska poruka pre nego što upit uopšte ode ka bazi.
  const shift = await prisma.shift.create({
    data: {
      restaurantId: ctx.restaurantId,
      locationId: input.locationId,
      openedBy: ctx.employeeId,
      openingCash: input.openingCash,
    },
  });

  await recordAuditEntry(ctx, {
    entityType: "Shift",
    entityId: shift.id,
    action: "shift.opened",
    newValue: { locationId: input.locationId, openingCash: input.openingCash },
  });

  return shift;
}
