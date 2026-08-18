/**
 * Idempotent permission backfill — grants newly-added Permission codes to
 * existing Role rows across ALL already-seeded restaurants, without
 * re-running seed.ts (which would create a brand new duplicate tenant).
 *
 * Safe to run repeatedly: Permission upsert is keyed by `code`, and
 * RolePermission grants use `skipDuplicates`, so re-running never creates
 * duplicate rows or touches unrelated data.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const NEW_PERMISSIONS = [
  { code: "orders.print", description: "Štampa/pregled/reprint kuhinjskog, šank i kupčevog tiketa (Faza 6)" },
  { code: "settings.manage", description: "Podešavanja restorana i konfiguracija štampača (Faza 6)" },
] as const;

const NEW_ROLE_GRANTS: Record<string, string[]> = {
  OWNER: ["orders.print", "settings.manage"],
  ADMIN: ["orders.print", "settings.manage"],
  MANAGER: ["orders.print", "settings.manage"],
  WAITER: ["orders.print"],
};

async function main() {
  const permissions = await Promise.all(
    NEW_PERMISSIONS.map((p) => prisma.permission.upsert({ where: { code: p.code }, create: p, update: {} }))
  );
  const permissionByCode = Object.fromEntries(permissions.map((p) => [p.code, p]));

  const roles = await prisma.role.findMany({
    where: { name: { in: Object.keys(NEW_ROLE_GRANTS) } },
  });

  let grantCount = 0;
  for (const role of roles) {
    const codes = NEW_ROLE_GRANTS[role.name] ?? [];
    const result = await prisma.rolePermission.createMany({
      data: codes.map((code) => ({ roleId: role.id, permissionId: permissionByCode[code].id })),
      skipDuplicates: true,
    });
    grantCount += result.count;
  }

  console.log(`✅ Phase 6 permission backfill: ${permissions.length} permission(s) upserted, ${grantCount} new role grant(s) across ${roles.length} existing role row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
