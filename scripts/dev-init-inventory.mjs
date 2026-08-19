#!/usr/bin/env node
/**
 * DEV/TEST-ONLY inventory initialization — sets starting stock = 30 for
 * every current menu item of the given restaurant/location, so the
 * complete sales -> stock decrement -> reporting flow can be exercised
 * end-to-end before a real restaurant goes live.
 *
 * SAFE TO RUN REPEATEDLY: it calls the same domain function the admin UI
 * uses (inventory.initializeTracking), which only creates an InventoryItem
 * + INITIAL movement when NONE exists yet for that (location, menuItem)
 * pair. An item that already has real test movements (received stock,
 * sales, manual adjustments, or a prior opening-stock reconciliation) is
 * left completely untouched — this script never overwrites existing stock.
 *
 * This is explicit, one-off DEV/TEST initialization — it is NOT run
 * automatically by anything (not wired into npm run dev, not a
 * postinstall/prebuild step), and it refuses to run with
 * NODE_ENV=production (same guard as scripts/dev-repair-accounts.ts).
 *
 * Run: RESTAURANT_ID=<id> LOCATION_ID=<id> npx tsx scripts/dev-init-inventory.mjs
 *      (LOCATION_ID is optional if the restaurant has exactly one location)
 */
import { PrismaClient } from "@prisma/client";
import { inventory } from "@rcs/domain";
import { loadEnv } from "./lib/env-loader.mjs";

loadEnv();

if (process.env.NODE_ENV === "production") {
  throw new Error("Zabranjeno pokretanje u produkciji.");
}

const STOCK = 30;
const prisma = new PrismaClient();

// Minimal local AuthContext-shaped object — mirrors packages/auth's
// AuthContext exactly (see rbac.ts) so inventory.initializeTracking's
// requirePermission/scopeToRestaurant calls behave identically to a real
// OWNER session. This script is DEV-only tooling, not a request handler —
// there is no real session to read a context from.
function ownerContext(restaurantId, employeeId) {
  return {
    userId: employeeId,
    employeeId,
    restaurantId,
    locationIds: ["ALL"],
    roles: ["OWNER"],
    permissions: new Set(["inventory.view", "inventory.manage", "inventory.opening_stock"]),
  };
}

async function main() {
  const restaurantId = process.env.RESTAURANT_ID;
  if (!restaurantId) {
    console.error("Greška: postavi RESTAURANT_ID environment promenljivu pre pokretanja.");
    console.error("Primer: RESTAURANT_ID=<id> LOCATION_ID=<id> npx tsx scripts/dev-init-inventory.mjs");
    process.exit(1);
  }

  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) {
    console.error(`Restoran sa id=${restaurantId} ne postoji.`);
    process.exit(1);
  }

  let locationId = process.env.LOCATION_ID;
  if (!locationId) {
    const locations = await prisma.location.findMany({ where: { restaurantId } });
    if (locations.length !== 1) {
      console.error(
        `Restoran ima ${locations.length} lokacija — postavi LOCATION_ID eksplicitno (nema jedinstvene podrazumevane lokacije).`
      );
      process.exit(1);
    }
    locationId = locations[0].id;
  }
  const location = await prisma.location.findFirst({ where: { id: locationId, restaurantId } });
  if (!location) {
    console.error(`Lokacija sa id=${locationId} ne pripada restoranu ${restaurantId}.`);
    process.exit(1);
  }

  const owner = await prisma.employee.findFirst({
    where: { restaurantId, roles: { some: { role: { name: "OWNER" } } }, status: "ACTIVE" },
  });
  if (!owner) {
    console.error("Nijedan aktivan OWNER zaposleni nije pronađen za ovaj restoran (potreban za audit identitet).");
    process.exit(1);
  }

  const menuItems = await prisma.menuItem.findMany({
    where: { restaurantId, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  console.log(`Restoran: ${restaurant.name} (${restaurant.id})`);
  console.log(`Lokacija: ${location.name} (${location.id})`);
  console.log(`Menu artikala (izvor istine — svi trenutni, bez izmišljenih): ${menuItems.length}\n`);

  if (menuItems.length === 0) {
    console.log("Nema menu artikala — ništa za inicijalizaciju.");
    return;
  }

  const ctx = ownerContext(restaurantId, owner.id);

  let created = 0;
  let alreadyTracked = 0;
  for (const item of menuItems) {
    const existing = await prisma.inventoryItem.findUnique({
      where: { locationId_menuItemId: { locationId, menuItemId: item.id } },
    });
    if (existing) {
      alreadyTracked++;
      continue;
    }
    // Calls the SAME domain function the admin UI uses — permission-checked,
    // scoped, and idempotent (only creates when no InventoryItem exists yet).
    await inventory.initializeTracking(ctx, { menuItemId: item.id, locationId, initialStock: STOCK });
    created++;
  }

  console.log(`Inicijalizovano na ${STOCK}: ${created} artikala`);
  console.log(`Već praćeno (preskočeno, netaknuto): ${alreadyTracked} artikala`);
  console.log("\nDev inventory init complete.");
}

main()
  .catch((e) => {
    console.error("Greška:", e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
