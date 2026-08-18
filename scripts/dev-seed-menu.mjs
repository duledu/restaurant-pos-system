/**
 * DEV MENU SEED — idempotent upsert of menu categories and items for the
 * development restaurant. Safe to run multiple times; uses
 * restaurantId+slug as the unique key (matches the @@unique in schema.prisma).
 *
 * Activates all items with dev placeholder prices so the Admin Menu and
 * Waiter POS are immediately usable without manual price entry.
 *
 * Run from the repo root:
 *   node scripts/dev-seed-menu.mjs
 */

import { readFileSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// ── Load DATABASE_URL from .env ───────────────────────────────────────────
const envPath = join(root, ".env");
const envText = readFileSync(envPath, "utf8");
for (const line of envText.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

const req = createRequire(join(root, "package.json"));
const { PrismaClient } = req("./node_modules/.prisma/client/index.js");
const prisma = new PrismaClient();

// ── Dev restaurant ────────────────────────────────────────────────────────
const RESTAURANT_ID = "63f03d5f-cd1e-4a3c-94df-f698cb953d52"; // Restoran (Dev)

// ── slugify — mirrors packages/db/prisma/seed-menu-data.ts ───────────────
function slugify(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[čć]/g, "c")
    .replace(/š/g, "s")
    .replace(/ž/g, "z")
    .replace(/đ/g, "dj")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ── Category definitions — mirrors seed-menu-data.ts CATEGORIES ──────────
const CATEGORIES = [
  { name: "Doručak",             type: "FOOD" },
  { name: "Hladna predjela",     type: "FOOD" },
  { name: "Topla predjela",      type: "FOOD" },
  { name: "Roštilj",            type: "FOOD" },
  { name: "Jela po narudžbini", type: "FOOD" },
  { name: "Salate",              type: "FOOD" },
  { name: "Zimske salate",       type: "FOOD" },
  { name: "Riba",                type: "FOOD" },
  { name: "Hleb",                type: "FOOD" },
  { name: "Deserti",             type: "FOOD" },
  { name: "Topli napici",        type: "DRINK" },
  { name: "Bezalkoholna pića",   type: "DRINK" },
  { name: "Voda",                type: "DRINK" },
  { name: "Pivo",                type: "DRINK" },
  { name: "Žestoka pića",        type: "DRINK" },
  { name: "Vino",                type: "DRINK" },
];

// ── Item definitions — mirrors seed-menu-data.ts MENU_BY_CATEGORY ─────────
const MENU_BY_CATEGORY = {
  dorucak: ["Pileća čorba", "Omlet", "Omlet sa sirom", "Omlet sa šunkom", "Omlet sa slaninom"],
  "hladna-predjela": ["Ordever"],
  "topla-predjela": [
    "Pohovani kačkavalj", "Pohovana zdenka", "Pomfrit", "Pomfrit sa sirom",
    "Pečurke na žaru", "Pohovane pečurke", "Grilovano povrće", "Topla daska",
  ],
  rostilj: [
    "Ćevap", "Pljeskavica 200 g", "Pljeskavica 300 g",
    "Gurmanska pljeskavica 200 g", "Gurmanska pljeskavica 300 g",
    "Punjena pljeskavica 200 g", "Punjena pljeskavica 300 g",
    "Punjena pljeskavica (kajmak i pršuta) 200 g", "Punjena pljeskavica (kajmak i pršuta) 300 g",
    "Uštipak", "Ćevapi u kajmaku", "Pileće belo", "Punjeno pileće belo",
    "Pileći batak", "Dimljeni batak", "Bečka šnicla (pileća)", "Bečka šnicla (svinjska)",
  ],
  "jela-po-narudzbini": [
    "Pileći prsti", "Pileća krilca", "Pileća Karađorđeva",
    "Pileći ražnjić", "Pileći ražnjić sa pršutom", "Pileći ražnjić sa slaninom",
    "Vešalica", "Punjena vešalica", "Svinjski ražnjić", "Svinjska kremenadla",
    "Dimljeni svinjski vrat", "Biftek", "Ramstek", "Teletina u sosu",
    "Goveđa kobasica", "Svinjska kobasica", "Svinjski file",
  ],
  salate: [
    "Srpska salata", "Šopska salata", "Grčka salata", "Mešana salata",
    "Krastavac salata", "Paradajz salata", "Kupus salata", "Vitaminska salata",
    "Urnebes salata", "Moravska salata", "Kravlji sir", "Kajmak",
    "Masline", "Ljuta papričica",
  ],
  "zimske-salate": [
    "Mešana zimska salata", "Zimski kupus", "Krompir salata",
    "Cvekla", "Ajvar", "Trljanica", "Paprika u pavlaci",
  ],
  riba: ["Pastrmka", "Škarpina"],
  hleb: ["Lepinja", "Lepinja sa sirom"],
  deserti: ["Palačinka sa kremom"],
  "topli-napici": ["Espresso", "Čaj"],
  "bezalkoholna-pica": [
    "Coca-Cola", "Coca-Cola Zero", "Fanta", "Sprite",
    "Schweppes Bitter Lemon", "Schweppes Tonic", "Jaffa",
    "Cedevita", "Ice Tea", "Ultra Energy", "Red Bull",
  ],
  voda: ["Rosa 0.33", "Rosa 0.75", "Bivoda 0.20", "Bivoda 1 l", "Heba", "BiAqua"],
  pivo: [
    "Zaječarsko 0.33", "Zaječarsko 0.50", "Pils",
    "Heineken 0.25", "Heineken 0.40", "Heineken 0.0",
    "Birra Moretti", "Laško 0.33", "Laško 0.50",
    "Niško", "Jelen", "Nikšićko", "Staropramen", "Bavaria", "Stella Artois",
  ],
  "zestoka-pica": [
    "Šljivovica", "Dunjevača", "Žolta Tikveš", "Vinjak", "Ouzo",
    "Stomaklija", "Vodka", "Viljamovka", "Gorki List", "Stock",
    "Johnnie Walker", "Jack Daniel's", "Gin", "Jagermeister", "Medovača", "Badel",
  ],
  vino: [
    "Graševina", "Smederevka", "Ždrepčeva krv", "Rose Tikveš",
    "Aleksandrija Belo", "Aleksandrija Crveno", "Tamjanika", "Tamjanika 0.187",
    "Aleksandrija Belo 0.187", "Aleksandrija Crveno 0.187", "Rose Tikveš 0.187",
    "Vermouth", "Somersby",
  ],
};

// Dev placeholder prices (RSD). No prices existed in real data;
// these are dev-only values so the menu is immediately usable.
const DEV_PRICE = {
  FOOD: 350,
  DRINK: 200,
};

async function main() {
  const restaurant = await prisma.restaurant.findUnique({ where: { id: RESTAURANT_ID } });
  if (!restaurant) {
    console.error("Dev restaurant not found:", RESTAURANT_ID);
    process.exit(1);
  }
  console.log("Seeding menu for:", restaurant.name, "(" + restaurant.id + ")");

  // ── 1. Upsert categories ─────────────────────────────────────────────────
  const categoryBySlug = new Map();
  for (const [index, cat] of CATEGORIES.entries()) {
    const slug = slugify(cat.name);
    const record = await prisma.menuCategory.upsert({
      where: { restaurantId_slug: { restaurantId: RESTAURANT_ID, slug } },
      create: { restaurantId: RESTAURANT_ID, name: cat.name, slug, type: cat.type, sortOrder: index },
      update: { name: cat.name, type: cat.type, sortOrder: index },
    });
    categoryBySlug.set(slug, { id: record.id, type: cat.type });
  }
  console.log("  categories:", CATEGORIES.length, "upserted");

  // ── 2. Upsert items ──────────────────────────────────────────────────────
  let created = 0;
  let updated = 0;
  for (const [categorySlug, names] of Object.entries(MENU_BY_CATEGORY)) {
    const cat = categoryBySlug.get(categorySlug);
    if (!cat) {
      console.warn("  WARN: unknown categorySlug:", categorySlug);
      continue;
    }
    const station = cat.type === "FOOD" ? "KITCHEN" : "BAR";
    const devPrice = cat.type === "FOOD" ? DEV_PRICE.FOOD : DEV_PRICE.DRINK;

    for (const name of names) {
      const slug = slugify(name);
      const existing = await prisma.menuItem.findUnique({
        where: { restaurantId_slug: { restaurantId: RESTAURANT_ID, slug } },
      });
      await prisma.menuItem.upsert({
        where: { restaurantId_slug: { restaurantId: RESTAURANT_ID, slug } },
        create: {
          restaurantId: RESTAURANT_ID,
          categoryId: cat.id,
          name,
          slug,
          price: devPrice,
          preparationStation: station,
          needsReview: false,
          isActive: true,
        },
        update: {
          categoryId: cat.id,
          preparationStation: station,
          // Only set price/active if item was previously missing or inactive
          // (preserves any real price the admin may have entered)
          ...(existing && existing.isActive ? {} : { price: devPrice, isActive: true, needsReview: false }),
        },
      });
      existing ? updated++ : created++;
    }
  }
  console.log("  items: " + created + " created, " + updated + " updated");

  // ── 3. Verify ────────────────────────────────────────────────────────────
  const catCount = await prisma.menuCategory.count({ where: { restaurantId: RESTAURANT_ID } });
  const itemCount = await prisma.menuItem.count({ where: { restaurantId: RESTAURANT_ID } });
  const activeCount = await prisma.menuItem.count({ where: { restaurantId: RESTAURANT_ID, isActive: true } });
  const kitchenCount = await prisma.menuItem.count({ where: { restaurantId: RESTAURANT_ID, preparationStation: "KITCHEN" } });
  const barCount = await prisma.menuItem.count({ where: { restaurantId: RESTAURANT_ID, preparationStation: "BAR" } });

  console.log("\nFinal state for", restaurant.name + ":");
  console.log("  MenuCategory:", catCount);
  console.log("  MenuItem:    ", itemCount, "(active:", activeCount + ")");
  console.log("  KITCHEN:     ", kitchenCount);
  console.log("  BAR:         ", barCount);
  console.log("\nDev prices: FOOD=" + DEV_PRICE.FOOD + " RSD, DRINK=" + DEV_PRICE.DRINK + " RSD");
  console.log("All items active=true, available to Admin Menu and Waiter POS.");
}

main()
  .then(() => {
    console.log("\nDev menu seed complete.");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
