/**
 * JEDNOKRATNA MIGRACIJA — prevodi nazive kategorija menija sa engleskog na srpski.
 *
 * Ažurira SAMO name i slug polja na postojećim MenuCategory redovima.
 * ID-evi ostaju nepromenjeni → sve MenuItem.categoryId veze su sačuvane.
 *
 * Skript je idempotent: ako je kategorija već prevedena (novi slug već postoji),
 * beleži "već ažurirano" i nastavlja dalje.
 *
 * Pokretanje:
 *   npm run db:migrate:categories
 * ili direktno:
 *   dotenv -e .env -- npx tsx packages/db/prisma/update-category-names.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TRANSLATIONS = [
  { from: "breakfast",       name: "Doručak",             to: "dorucak" },
  { from: "cold-appetizers", name: "Hladna predjela",     to: "hladna-predjela" },
  { from: "hot-appetizers",  name: "Topla predjela",      to: "topla-predjela" },
  { from: "grill",           name: "Roštilj",             to: "rostilj" },
  { from: "made-to-order",   name: "Jela po narudžbini",  to: "jela-po-naruzbini" },
  { from: "salads",          name: "Salate",              to: "salate" },
  { from: "winter-salads",   name: "Zimske salate",       to: "zimske-salate" },
  { from: "fish",            name: "Riba",                to: "riba" },
  { from: "bread",           name: "Hleb",                to: "hleb" },
  { from: "desserts",        name: "Deserti",             to: "deserti" },
  { from: "hot-drinks",      name: "Topli napici",        to: "topli-napici" },
  { from: "soft-drinks",     name: "Bezalkoholna pića",   to: "bezalkoholna-pica" },
  { from: "water",           name: "Voda",                to: "voda" },
  { from: "beer",            name: "Pivo",                to: "pivo" },
  { from: "spirits",         name: "Žestoka pića",        to: "zestoka-pica" },
  { from: "wine",            name: "Vino",                to: "vino" },
] as const;

async function main() {
  const restaurantId = process.env.RESTAURANT_ID;
  if (!restaurantId) {
    console.error("Postavi RESTAURANT_ID environment promenljivu.");
    process.exit(1);
  }

  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) {
    console.error(`Restoran ${restaurantId} nije pronađen.`);
    process.exit(1);
  }

  console.log(`Prevod kategorija menija za: ${restaurant.name} (${restaurant.id})\n`);

  const itemsBefore = await prisma.menuItem.count({ where: { restaurantId } });
  console.log(`Artikala pre ažuriranja: ${itemsBefore}\n`);

  let updated = 0;
  let alreadyDone = 0;
  let missing = 0;

  for (const { from, name, to } of TRANSLATIONS) {
    const result = await prisma.menuCategory.updateMany({
      where: { restaurantId, slug: from },
      data: { name, slug: to },
    });

    if (result.count > 0) {
      console.log(`  ✓  '${from}' → '${to}'  (${name})`);
      updated++;
    } else {
      const check = await prisma.menuCategory.findFirst({
        where: { restaurantId, slug: to },
        select: { name: true },
      });
      if (check) {
        console.log(`  ⏭  '${to}' — već ažurirano (${check.name})`);
        alreadyDone++;
      } else {
        console.warn(`  ⚠️  Kategorija '${from}' nije pronađena niti kao '${to}'`);
        missing++;
      }
    }
  }

  console.log(`\nRezultat: ${updated} ažurirano, ${alreadyDone} već ok, ${missing} nije pronađeno`);

  const itemsAfter = await prisma.menuItem.count({ where: { restaurantId } });
  console.log(`\nArtikala posle ažuriranja: ${itemsAfter}`);

  if (itemsBefore !== itemsAfter) {
    console.error("⛔ GREŠKA: Broj artikala se promenio! Proveri bazu.");
    process.exit(1);
  }
  console.log("✓ Broj artikala nepromenjen — categoryId veze su sačuvane.\n");

  const allCategories = await prisma.menuCategory.findMany({
    where: { restaurantId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, slug: true, type: true },
  });

  console.log("Konačno stanje kategorija:");
  for (const cat of allCategories) {
    const itemCount = await prisma.menuItem.count({ where: { restaurantId, categoryId: cat.id } });
    const icon = cat.type === "FOOD" ? "🍽 " : "🥤";
    console.log(`  ${icon} ${cat.name.padEnd(24)} (${cat.slug}) — ${itemCount} artikala`);
  }

  console.log("\n✅ Migracija završena.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
