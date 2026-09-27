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
  { code: "promotions.view", description: "Pregled promocija (Happy Hour i slično)" },
  { code: "promotions.manage", description: "Kreiranje/izmena/aktivacija/deaktivacija promocija" },
  { code: "reservations.view", description: "Pregled rezervacija" },
  { code: "reservations.manage", description: "Kreiranje/izmena/otkazivanje rezervacija, smeštanje gostiju" },
  { code: "qr_menu.view", description: "Pregled podešavanja QR menija" },
  { code: "qr_menu.manage", description: "Izmena brendiranja/izgleda QR menija, adrese menija, QR kodova stolova" },
] as const;

export const NEW_ROLE_GRANTS: Record<string, string[]> = {
  OWNER: ["inventory.count", "workstations.manage", "promotions.view", "promotions.manage", "reservations.view", "reservations.manage", "qr_menu.view", "qr_menu.manage"],
  ADMIN: ["inventory.count", "workstations.manage", "promotions.view", "promotions.manage", "reservations.view", "reservations.manage", "qr_menu.view", "qr_menu.manage"],
  MANAGER: ["inventory.count", "workstations.manage", "promotions.view", "promotions.manage", "reservations.view", "reservations.manage", "qr_menu.view", "qr_menu.manage"],
  // Inventory Phase 2 fix — INVENTORY_MANAGER je propušten u originalnom
  // Fazi 2A grantu (samo inventory.count je bio nameravan za tu ulogu, vidi
  // istoriju ovog fajla), sada dodato. workstations.manage pripada istoj
  // "operativni menadžment lokacije" grupi permisija kao
  // settings.manage/production.manage — KITCHEN/BAR NAMERNO ostaju bez ovoga
  // (operativne uloge koje PRIMAJU/štampaju tikete, ne administriraju radne
  // stanice). promotions.* NAMERNO izostavljeno za INVENTORY_MANAGER —
  // cenovna/promotivna politika nije deo te uloge (isti razlog kao
  // menu.manage isključenje za WAITER/KITCHEN/BAR/INVENTORY_MANAGER u seed.ts).
  // reservations.* SE RAZLIKUJE od promotions.* — konobar je taj koji prima
  // telefonski poziv i pravi/menja rezervaciju tokom smene (specifikacija
  // "dovoljno brzo da se radi dok se priča telefonom sa gostom"), zato WAITER
  // ovde dobija oba reservations koda, za razliku od promotions.*.
  WAITER: ["reservations.view", "reservations.manage"],
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
