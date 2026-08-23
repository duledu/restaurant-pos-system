#!/usr/bin/env node
// Jednokratni, EKSPLICITNO zaštićen skript koji ubacuje probne sirovine
// (Part 19 iz P1 Normativi zahteva) — SAMO u DEVELOPMENT bazu (identičan
// multi-signal gate kao svaki drugi dev-only mutation skript u ovom
// projektu), NIKAD u PRODUCTION, i namerno NE u TEST (test baza se
// resetuje na svaki test run — trajni sample podaci tamo nemaju svrhu).
//
// Koristi: node scripts/seed-normativi-sample-data.mjs
import { PrismaClient } from "@prisma/client";
import { assertDevelopmentDatabaseIsSafe } from "./lib/db-environment.mjs";

const SAMPLE_INGREDIENTS = [
  { name: "Mleveno meso", unit: "KILOGRAM", category: "Meso" },
  { name: "Luk", unit: "KILOGRAM", category: "Povrće" },
  { name: "Lepinja", unit: "PIECE", category: "Pekarski proizvodi" },
  { name: "Ulje", unit: "LITER", category: "Začini i ulja" },
  { name: "Krompir", unit: "KILOGRAM", category: "Povrće" },
  { name: "So", unit: "KILOGRAM", category: "Začini i ulja" },
  { name: "Kafa", unit: "KILOGRAM", category: "Piće" },
];

async function main() {
  // STEP 0 — isti multi-signal gate kao svaki drugi dev-only skript:
  // NODE_ENV, poznati Production/Test endpoint, i live marker tabela
  // moraju SVI nezavisno potvrditi da je cilj DEVELOPMENT.
  await assertDevelopmentDatabaseIsSafe(process.env.DATABASE_URL);

  const prisma = new PrismaClient();
  try {
    const restaurants = await prisma.restaurant.findMany({ select: { id: true, name: true } });
    if (restaurants.length === 0) {
      console.log("[seed-normativi] Nema restorana u ovoj bazi — ništa za ubaciti.");
      return;
    }

    for (const restaurant of restaurants) {
      const existing = await prisma.ingredient.findMany({
        where: { restaurantId: restaurant.id },
        select: { name: true },
      });
      const existingNames = new Set(existing.map((i) => i.name));

      const toCreate = SAMPLE_INGREDIENTS.filter((s) => !existingNames.has(s.name));
      if (toCreate.length === 0) {
        console.log(`[seed-normativi] "${restaurant.name}" već ima sve probne sirovine — preskačem.`);
        continue;
      }

      await prisma.ingredient.createMany({
        data: toCreate.map((s) => ({
          restaurantId: restaurant.id,
          name: s.name,
          unit: s.unit,
          category: s.category,
        })),
      });
      console.log(`[seed-normativi] "${restaurant.name}": dodato ${toCreate.length} probnih sirovina (${toCreate.map((s) => s.name).join(", ")}).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[seed-normativi] Greška:", err);
  process.exit(1);
});
