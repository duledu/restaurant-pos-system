/**
 * Idempotent permission backfill — grants newly-added Permission codes to
 * existing Role rows across ALL already-seeded restaurants, without
 * re-running seed.ts (which would create a brand new duplicate tenant).
 *
 * Safe to run repeatedly: Permission upsert is keyed by `code`, and
 * RolePermission grants use `skipDuplicates`, so re-running never creates
 * duplicate rows or touches unrelated data.
 *
 * DATABASE TARGETING (post 2026-09-14 incident — see
 * scripts/lib/resolve-db-target.mjs): this script no longer does a bare
 * `new PrismaClient()`, which silently resolved to Production because
 * @prisma/client's own env loading only ever reads root `.env` (never
 * `.env.local`). It now REQUIRES an explicit --env flag, resolved and
 * cross-checked against the live _rcs_database_environment marker before
 * any write.
 *
 * Run:
 *   npm run db:preprod:permissions
 *   npm run db:production:permissions -- --confirm-production
 */
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";
import { resolveDatabaseTarget } from "../../../scripts/lib/resolve-db-target.mjs";

const NEW_PERMISSIONS = [
  { code: "inventory.count", description: "Fizičko prebrojavanje zaliha (Inventura) — sesija/redovi/potvrda" },
  { code: "workstations.manage", description: "Uparivanje/opoziv TableCore Print Agent radnih stanica (Faza 2A)" },
] as const;

export const NEW_ROLE_GRANTS: Record<string, string[]> = {
  OWNER: ["inventory.count", "workstations.manage"],
  ADMIN: ["inventory.count", "workstations.manage"],
  MANAGER: ["inventory.count", "workstations.manage"],
  // Inventory Phase 2 fix — INVENTORY_MANAGER je propušten u originalnom
  // Fazi 2A grantu (samo inventory.count je bio nameravan za tu ulogu, vidi
  // istoriju ovog fajla), sada dodato. workstations.manage pripada istoj
  // "operativni menadžment lokacije" grupi permisija kao
  // settings.manage/production.manage — KITCHEN/BAR NAMERNO ostaju bez ovoga
  // (operativne uloge koje PRIMAJU/štampaju tikete, ne administriraju radne
  // stanice).
  INVENTORY_MANAGER: ["inventory.count", "workstations.manage"],
};

async function main() {
  const target = await resolveDatabaseTarget();
  const prisma = new PrismaClient({ datasources: { db: { url: target.databaseUrl } } });

  try {
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

    console.log(
      `✅ Phase 6 permission backfill [${target.environment}]: ${permissions.length} permission(s) upserted, ` +
        `${grantCount} new role grant(s) across ${roles.length} existing role row(s).`
    );
  } finally {
    await prisma.$disconnect();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
