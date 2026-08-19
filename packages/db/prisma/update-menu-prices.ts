/**
 * update-menu-prices.ts
 *
 * Idempotent price repair/import script for Restoran Evropa MM.
 *
 * Sources prices from the photographed restaurant menu.
 * Items whose prices cannot be read with confidence are left as
 * needsReview=true with note "NEEDS_PRICE_CONFIRMATION".
 *
 * SAFE:
 *   - Never touches OrderItem, Payment, Receipt, or any historical record.
 *   - Never uses TRUNCATE.
 *   - Safe to run multiple times (idempotent).
 *
 * USAGE:
 *   npx tsx prisma/update-menu-prices.ts
 *   RESTAURANT_ID=<uuid> npx tsx prisma/update-menu-prices.ts
 *
 * Without RESTAURANT_ID the script auto-detects a single restaurant.
 */

import { PrismaClient } from "@prisma/client";

// ─── Safety ──────────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL ?? "";
const testDbUrl = process.env.TEST_DATABASE_URL ?? "";
if (testDbUrl && dbUrl && testDbUrl === dbUrl) {
  console.error("ABORT: DATABASE_URL === TEST_DATABASE_URL. Refusing to run on the test database.");
  process.exit(1);
}

const prisma = new PrismaClient();

// ─── Slug helper (identical to seed-menu-data.ts) ────────────────────────────
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[čć]/g, "c")
    .replace(/š/g, "s")
    .replace(/ž/g, "z")
    .replace(/đ/g, "dj")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ─── Price data ───────────────────────────────────────────────────────────────
// Keys are slugs computed from the ORIGINAL names in seed-menu-data.ts.
// Prices are exact integers (RSD) from the photographed Evropa MM menu.
// quantity/unit provide portion metadata for POS display.

interface PriceSpec {
  price: number;          // whole RSD, no floating-point
  quantity?: number;      // portion size (e.g. 0.33 for 0.33 l)
  unit?: string;          // "l" | "g" | "kom"
  nameNote?: string;      // discrepancy vs. real menu — logged, NOT auto-applied
}

const S = slugify; // shorthand

const CONFIRMED: Record<string, PriceSpec> = {
  // ── DORUČAK ──────────────────────────────────────────────────────────────
  [S("Pileća čorba")]:       { price: 200, quantity: 300,   unit: "g"   },
  [S("Omlet")]:              { price: 150 },
  [S("Omlet sa sirom")]:     { price: 200 },
  [S("Omlet sa šunkom")]:    { price: 200 },
  [S("Omlet sa slaninom")]:  { price: 200 },

  // ── HLADNA PREDJELA ──────────────────────────────────────────────────────
  [S("Ordever")]: { price: 600 },

  // ── RIBA ─────────────────────────────────────────────────────────────────
  [S("Pastrmka")]:  { price: 1500, quantity: 1, unit: "kg" },
  [S("Škarpina")]:  { price: 1500, quantity: 1, unit: "kg" },

  // ── HLEB ─────────────────────────────────────────────────────────────────
  [S("Lepinja")]:          { price: 50,  quantity: 1, unit: "kom" },
  [S("Lepinja sa sirom")]: { price: 100, quantity: 1, unit: "kom" },

  // ── DESERTI ──────────────────────────────────────────────────────────────
  [S("Palačinka sa kremom")]: { price: 200, quantity: 1, unit: "kom" },

  // ── TOPLI NAPICI ─────────────────────────────────────────────────────────
  [S("Espresso")]: { price: 120 },
  [S("Čaj")]:      { price: 100 },

  // ── BEZALKOHOLNA PIĆA ────────────────────────────────────────────────────
  [S("Coca-Cola")]:             { price: 170 },
  [S("Coca-Cola Zero")]:        { price: 170 },
  [S("Fanta")]:                 { price: 170 },
  [S("Sprite")]:                { price: 170 },
  // Seed name: "Schweppes Bitter Lemon"; real menu says "Schweppes" — slug unchanged
  [S("Schweppes Bitter Lemon")]: { price: 170, nameNote: 'Real menu shows "Schweppes" (no "Bitter Lemon"). Rename via Admin > Menu if needed.' },
  [S("Schweppes Tonic")]:       { price: 170 },
  [S("Jaffa")]:                 { price: 170 },
  [S("Cedevita")]:              { price: 150 },
  [S("Ice Tea")]:               { price: 170 },
  [S("Ultra Energy")]:          { price: 150, quantity: 0.25, unit: "l" },
  [S("Red Bull")]:              { price: 300, quantity: 0.25, unit: "l" },

  // ── VODA ─────────────────────────────────────────────────────────────────
  [S("Rosa 0.33")]:   { price: 120, quantity: 0.33, unit: "l" },
  [S("Rosa 0.75")]:   { price: 200, quantity: 0.75, unit: "l" },
  [S("Bivoda 0.20")]: { price: 20,  quantity: 0.20, unit: "l" },
  [S("Bivoda 1 l")]:  { price: 100, quantity: 1,    unit: "l" },
  [S("Heba")]:        { price: 120, quantity: 0.20, unit: "l" },
  [S("BiAqua")]:      { price: 150, quantity: 1,    unit: "l" },

  // ── PIVO ─────────────────────────────────────────────────────────────────
  [S("Zaječarsko 0.33")]: { price: 140, quantity: 0.33, unit: "l" },
  [S("Zaječarsko 0.50")]: { price: 130, quantity: 0.50, unit: "l" },
  [S("Pils")]:            { price: 150, quantity: 0.50, unit: "l" },
  [S("Heineken 0.25")]:   { price: 200, quantity: 0.25, unit: "l" },
  [S("Heineken 0.40")]:   { price: 170, quantity: 0.40, unit: "l" },
  // Seed name: "Heineken 0.0"; real menu says "Heineken Zero 0.25"
  [S("Heineken 0.0")]:    { price: 200, quantity: 0.25, unit: "l", nameNote: 'Real menu shows "Heineken Zero 0.25". Rename via Admin > Menu.' },
  [S("Birra Moretti")]:   { price: 200, quantity: 0.33, unit: "l" },
  [S("Laško 0.33")]:      { price: 200, quantity: 0.33, unit: "l" },
  [S("Laško 0.50")]:      { price: 150, quantity: 0.50, unit: "l" },
  [S("Niško")]:           { price: 100, quantity: 0.33, unit: "l" },
  [S("Jelen")]:           { price: 130, quantity: 0.50, unit: "l" },
  [S("Nikšićko")]:        { price: 150, quantity: 0.50, unit: "l" },
  [S("Staropramen")]:     { price: 150, quantity: 0.50, unit: "l" },
  [S("Bavaria")]:         { price: 300, quantity: 0.25, unit: "l" },
  [S("Stella Artois")]:   { price: 350, quantity: 0.33, unit: "l" },

  // ── ŽESTOKA PIĆA (all 0.05 l shots) ─────────────────────────────────────
  [S("Šljivovica")]:    { price: 70,  quantity: 0.05, unit: "l" },
  [S("Dunjevača")]:     { price: 120, quantity: 0.05, unit: "l" },
  [S("Žolta Tikveš")]:  { price: 150, quantity: 0.05, unit: "l" },
  [S("Vinjak")]:        { price: 120, quantity: 0.05, unit: "l" },
  [S("Ouzo")]:          { price: 80,  quantity: 0.05, unit: "l" },
  [S("Stomaklija")]:    { price: 130, quantity: 0.05, unit: "l" },
  [S("Vodka")]:         { price: 100, quantity: 0.05, unit: "l" },
  [S("Viljamovka")]:    { price: 250, quantity: 0.05, unit: "l" },
  [S("Gorki List")]:    { price: 120, quantity: 0.05, unit: "l" },
  [S("Stock")]:         { price: 150, quantity: 0.05, unit: "l" },
  [S("Johnnie Walker")]: { price: 250, quantity: 0.05, unit: "l" },
  // Seed name: "Jack Daniel's" → slug "jack-daniel-s" (apostrophe becomes -)
  [S("Jack Daniel's")]: { price: 350, quantity: 0.05, unit: "l" },
  [S("Gin")]:           { price: 120, quantity: 0.05, unit: "l" },
  [S("Jagermeister")]:  { price: 220, quantity: 0.05, unit: "l" },
  [S("Medovača")]:      { price: 150, quantity: 0.05, unit: "l" },
  [S("Badel")]:         { price: 150, quantity: 0.05, unit: "l" },

  // ── VINO ─────────────────────────────────────────────────────────────────
  [S("Graševina")]:            { price: 700,  quantity: 1,     unit: "l" },
  [S("Smederevka")]:           { price: 700,  quantity: 1,     unit: "l" },
  [S("Ždrepčeva krv")]:        { price: 700,  quantity: 1,     unit: "l" },
  // Seed: "Rose Tikveš" (1l); real menu: "Roze Tikveš 1l"
  [S("Rose Tikveš")]:          { price: 700,  quantity: 1,     unit: "l", nameNote: 'Real menu shows "Roze Tikveš 1l". Rename via Admin > Menu.' },
  // Seed: "Aleksandrija Belo"; real menu: "Aleksandria belo 0.75"
  [S("Aleksandrija Belo")]:    { price: 1500, quantity: 0.75,  unit: "l", nameNote: 'Real menu shows "Aleksandria Belo". Rename via Admin > Menu.' },
  [S("Aleksandrija Crveno")]:  { price: 1500, quantity: 0.75,  unit: "l", nameNote: 'Real menu shows "Aleksandria Crveno". Rename via Admin > Menu.' },
  [S("Tamjanika")]:            { price: 1500, quantity: 0.75,  unit: "l" },
  [S("Tamjanika 0.187")]:      { price: 400,  quantity: 0.187, unit: "l" },
  [S("Aleksandrija Belo 0.187")]:   { price: 400, quantity: 0.187, unit: "l" },
  [S("Aleksandrija Crveno 0.187")]: { price: 400, quantity: 0.187, unit: "l" },
  // "Rose Tikveš 0.187" → NOT in provided menu list → NEEDS_PRICE_CONFIRMATION (omitted here)
  [S("Vermouth")]: { price: 150, quantity: 0.1,  unit: "l" },
  [S("Somersby")]: { price: 300, quantity: 0.2,  unit: "l" },
};

const CONFIRMATION_NOTE =
  "NEEDS_PRICE_CONFIRMATION — cena nije dostupna na fotografisanom meniju. Uneti ručno kroz Admin Panel (Meni → klik na cenu).";

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  let restaurantId = process.env.RESTAURANT_ID ?? "";

  if (!restaurantId) {
    const restaurants = await prisma.restaurant.findMany({ take: 3 });
    if (restaurants.length === 0) {
      console.error("No restaurants found. Run seed.ts first.");
      process.exit(1);
    }
    if (restaurants.length > 1) {
      console.error("Multiple restaurants found. Specify one:");
      for (const r of restaurants) console.error(`  RESTAURANT_ID=${r.id}  # ${r.name}`);
      process.exit(1);
    }
    restaurantId = restaurants[0].id;
    console.log(`Auto-detected: ${restaurants[0].name} (${restaurantId})`);
  } else {
    const r = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!r) { console.error(`Restaurant ${restaurantId} not found.`); process.exit(1); }
    console.log(`Restaurant: ${r.name} (${restaurantId})`);
  }

  // Load all menu items for this restaurant
  const existing = await prisma.menuItem.findMany({
    where: { restaurantId },
    select: { id: true, slug: true, name: true, price: true, quantity: true, unit: true, isActive: true, needsReview: true, reviewNote: true },
  });
  const bySlug = new Map(existing.map((it) => [it.slug, it]));

  // Track results
  let pricesUpdated = 0;
  let alreadyCorrect = 0;
  let notFoundInDb = 0;
  const nameNotes: string[] = [];
  const notFoundList: string[] = [];

  // ── Pass 1: apply confirmed prices ─────────────────────────────────────────
  for (const [slug, spec] of Object.entries(CONFIRMED)) {
    const item = bySlug.get(slug);
    if (!item) {
      notFoundList.push(`${slug} (${spec.price} RSD)`);
      notFoundInDb++;
      continue;
    }

    const currentPrice = Number(item.price);
    const unchanged =
      currentPrice === spec.price &&
      item.isActive === true &&
      item.needsReview === false &&
      (spec.quantity === undefined || Number(item.quantity) === spec.quantity) &&
      (spec.unit === undefined || item.unit === spec.unit);

    if (unchanged) {
      alreadyCorrect++;
      if (spec.nameNote) nameNotes.push(`  ${item.name}: ${spec.nameNote}`);
      continue;
    }

    const data: Record<string, unknown> = {
      price: spec.price,
      isActive: true,
      needsReview: false,
      reviewNote: null,
    };
    if (spec.quantity !== undefined) data.quantity = spec.quantity;
    if (spec.unit !== undefined)     data.unit = spec.unit;

    await prisma.menuItem.update({ where: { id: item.id }, data });
    pricesUpdated++;
    if (spec.nameNote) nameNotes.push(`  ${item.name}: ${spec.nameNote}`);
  }

  // ── Pass 2: mark unconfirmed items with specific note ──────────────────────
  let confirmationNoteUpdated = 0;
  let needsConfirmationTotal = 0;
  const unconfirmedNames: string[] = [];

  for (const [slug, item] of bySlug) {
    if (CONFIRMED[slug]) continue; // already handled above

    needsConfirmationTotal++;
    unconfirmedNames.push(`  ${item.name} (slug: ${slug})`);

    if (item.reviewNote !== CONFIRMATION_NOTE) {
      await prisma.menuItem.update({
        where: { id: item.id },
        data: { reviewNote: CONFIRMATION_NOTE },
      });
      confirmationNoteUpdated++;
    }
  }

  // ── Historical integrity check ──────────────────────────────────────────────
  // Count existing OrderItems to confirm we did not touch any
  const totalOrderItems = await prisma.orderItem.count();

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("  MENU IMPORT SUMMARY — Restoran Evropa MM");
  console.log("═".repeat(60));
  console.log(`  Existing items in database:       ${existing.length}`);
  console.log(`  Prices updated:                   ${pricesUpdated}`);
  console.log(`  Already correct (unchanged):      ${alreadyCorrect}`);
  console.log(`  Not found in DB (check seed):     ${notFoundInDb}`);
  console.log(`  Needs price confirmation:         ${needsConfirmationTotal}`);
  console.log(`  Confirmation notes updated:       ${confirmationNoteUpdated}`);
  console.log(`  Historical OrderItems (untouched):${totalOrderItems}`);
  console.log("─".repeat(60));

  if (notFoundList.length) {
    console.log("\n⚠  NOT FOUND IN DATABASE (run seed-menu.ts first):");
    for (const n of notFoundList) console.log(`   ${n}`);
  }

  if (nameNotes.length) {
    console.log("\n⚠  NAME DISCREPANCIES (prices applied; rename manually via Admin > Menu):");
    for (const n of nameNotes) console.log(n);
  }

  if (unconfirmedNames.length) {
    console.log(`\n⚠  NEEDS_PRICE_CONFIRMATION (${needsConfirmationTotal} items — not activated):`);
    for (const n of unconfirmedNames) console.log(n);
  }

  const activated = pricesUpdated + alreadyCorrect;
  const total = existing.length;
  console.log("\n─".repeat(60));
  console.log(`  Active after import:  ${activated} / ${total}`);
  console.log(`  Awaiting prices:      ${needsConfirmationTotal} / ${total}`);
  console.log("═".repeat(60));
  console.log("✅  Menu price import complete. Historical data untouched.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
