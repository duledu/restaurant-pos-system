import { prisma } from "@rcs/db";
import {
  requirePermission,
  scopeToRestaurant,
  hashPassword,
  normalizeEmail,
  hashPin,
  type AuthContext,
} from "@rcs/auth";
import { recordAuditEntry } from "../audit/audit-service";
import type { CreateEmployeeInput } from "@rcs/shared";

/**
 * Lista zaposlenih restorana. Tenant scoping se sprovodi eksplicitno kroz
 * scopeToRestaurant(ctx) — nijedan upit u ovom modulu ne sme koristiti
 * restaurantId iz bilo kog izvora osim AuthContext-a.
 */
export async function listEmployees(ctx: AuthContext) {
  requirePermission(ctx, "employees.view");

  return prisma.employee.findMany({
    where: scopeToRestaurant(ctx),
    include: {
      roles: { include: { role: true } },
      locations: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Kreira zaposlenog + (opciono) login nalog + role + lokacije u jednoj
 * transakciji. Ako bilo koji korak ne uspe, ništa se ne upisuje.
 */
export async function createEmployee(ctx: AuthContext, input: CreateEmployeeInput) {
  requirePermission(ctx, "employees.manage");

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

    return created;
  });

  await recordAuditEntry(ctx, {
    entityType: "Employee",
    entityId: employee.id,
    action: "employee.created",
    newValue: { firstName: input.firstName, lastName: input.lastName, roleNames: input.roleNames },
  });

  return employee;
}
