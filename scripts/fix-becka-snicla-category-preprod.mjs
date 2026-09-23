#!/usr/bin/env node
// Inventory Phase 1 — one-off PREPROD data correction, NOT a code fix.
//
// "Bečka šnicla (pileća)"/"Bečka šnicla (svinjska)" were seeded under
// "Roštilj" (packages/db/prisma/seed-menu-data.ts) but belong under the
// already-existing "Jela po narudžbini" category — both categories already
// exist in the schema/seed data; this does NOT create a new category, and
// does NOT hardcode this correction into any domain/source file. It
// replicates exactly what menu.moveToCategory(...) does (validate the
// target category belongs to the same restaurant, update categoryId,
// record an audit entry) — the SAME thing an Admin could already do by
// hand via the Meni page's category <select> for these two specific rows.
//
// Deliberately does NOT import { menu } from "@rcs/domain": that module
// transitively imports @rcs/db, whose `prisma` client (packages/db/index.ts)
// is constructed EAGERLY at import time from ambient process.env — the
// exact class of bug documented in scripts/lib/resolve-db-target.mjs's own
// header comment (the 2026-09-14 incident). This script's ONLY database
// client is the one explicitly constructed below from resolveDatabaseTarget()'s
// verified PREPROD URL — nothing here can silently resolve to a different
// database. Same pattern as scripts/seed-normativi-sample-data.mjs.
//
// PREPROD-ONLY. Refuses to run without an explicit --env=preprod flag,
// cross-verified against the live database's own _rcs_database_environment
// marker table (not just the flag or a filename).
//
// Run: node scripts/fix-becka-snicla-category-preprod.mjs --env=preprod
import { PrismaClient } from "@prisma/client";
import { resolveDatabaseTarget } from "./lib/resolve-db-target.mjs";

const ITEM_NAMES = ["Bečka šnicla (pileća)", "Bečka šnicla (svinjska)"];
const FROM_CATEGORY = "Roštilj";
const TO_CATEGORY = "Jela po narudžbini";

async function main() {
  const target = await resolveDatabaseTarget();
  if (target.environment !== "preprod") {
    throw new Error(`fix-becka-snicla-category-preprod.mjs is PREPROD-only, got --env=${target.environment}.`);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: target.databaseUrl } } });
  try {
    const restaurants = await prisma.restaurant.findMany({ select: { id: true, name: true } });
    for (const restaurant of restaurants) {
      const toCategory = await prisma.menuCategory.findFirst({ where: { restaurantId: restaurant.id, name: TO_CATEGORY } });
      if (!toCategory) {
        console.log(`[${restaurant.name}] nema kategoriju "${TO_CATEGORY}" — preskačem.`);
        continue;
      }
      const items = await prisma.menuItem.findMany({
        where: { restaurantId: restaurant.id, name: { in: ITEM_NAMES }, category: { name: FROM_CATEGORY } },
        select: { id: true, name: true, categoryId: true },
      });
      if (items.length === 0) {
        console.log(`[${restaurant.name}] nijedna stavka nije pronađena pod "${FROM_CATEGORY}" — ništa za ispraviti (možda je već ispravljeno, ili restoran nema ove artikle).`);
        continue;
      }
      for (const item of items) {
        await prisma.$transaction([
          prisma.menuItem.update({ where: { id: item.id }, data: { categoryId: toCategory.id } }),
          prisma.auditLog.create({
            data: {
              restaurantId: restaurant.id,
              locationId: null,
              userId: "script:fix-becka-snicla-category",
              role: "OWNER",
              entityType: "MenuItem",
              entityId: item.id,
              action: "menu_item.category_changed",
              previousValue: { categoryId: item.categoryId },
              newValue: { categoryId: toCategory.id },
            },
          }),
        ]);
        console.log(`[${restaurant.name}] "${item.name}": ${FROM_CATEGORY} -> ${TO_CATEGORY}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
