/**
 * MENU IMPORT SEED — idempotentan (UPSERT po (restaurantId, slug)).
 * Pokretanje više puta NE pravi duplikate (dokazano integracionim testovima
 * u tests/integration/menu-upsert-idempotency.test.ts) — i MenuCategory i
 * MenuItem imaju @@unique([restaurantId, slug]) u šemi; ova skripta koristi
 * tačno taj par kao ključ za upsert.
 *
 * ODVOJENO od packages/db/prisma/seed.ts namerno — vidi napomenu tamo.
 *
 * POKRETANJE:
 *   RESTAURANT_ID=<id> npx ts-node prisma/seed-menu.ts
 *
 * NAPOMENA O TIPOVIMA: namerno NE uvozim CategoryType/PreparationStation
 * enume iz "@prisma/client" — ti tipovi postoje tek nakon `prisma generate`,
 * a ova skripta treba da bude typecheck-ovana i u okruženjima gde to još
 * nije pokrenuto. Koristim lokalne string-literal tipove ispod; Prisma u
 * runtime-u prihvata iste string vrednosti za enum kolone.
 *
 * STATUS PODATAKA (ažurirano): zvaničan spisak naziva artikala je dobijen
 * (137 artikala, 16 kategorija, tačno kako je dostavljeno — nazivi nisu
 * menjani, uključujući gramature koje su deo naziva npr. "Pljeskavica 200
 * g"). NIJEDNA CENA nije dostavljena ni za jedan artikal na spisku — zato
 * je SVAKI artikal ovde needsReview=true, price=0, isActive=false. Ovo nije
 * greška, već namerna posledica pravila "ne izmišljaj cene": artikli će
 * postati vidljivi/aktivni tek kad vlasnik/administrator unese stvarnu cenu
 * kroz Admin Panel (Meni → klik na cenu → unos → Sačuvaj).
 */
import { PrismaClient } from "@prisma/client";
import {
  CATEGORIES,
  REVIEW_NOTE,
  MENU_BY_CATEGORY,
  slugify,
  type PreparationStationValue,
} from "./seed-menu-data";

const prisma = new PrismaClient();

interface MenuItemSeed {
  categorySlug: string;
  name: string;
  price: number | null;
  needsReview: boolean;
  reviewNote?: string;
}

const MENU_ITEMS: MenuItemSeed[] = Object.entries(MENU_BY_CATEGORY).flatMap(([categorySlug, names]) =>
  names.map((name) => ({
    categorySlug,
    name,
    price: null,
    needsReview: true,
    reviewNote: REVIEW_NOTE,
  }))
);

async function main() {
  const restaurantId = process.env.RESTAURANT_ID;
  if (!restaurantId) {
    console.error("Greška: postavi RESTAURANT_ID environment promenljivu pre pokretanja.");
    console.error("Primer: RESTAURANT_ID=<id-iz-seed.ts-izlaza> npx ts-node prisma/seed-menu.ts");
    process.exit(1);
  }

  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) {
    console.error(`Restoran sa id=${restaurantId} ne postoji.`);
    process.exit(1);
  }

  console.log(`Uvoz menija za restoran: ${restaurant.name} (${restaurant.id})`);

  const categoryBySlug = new Map<string, { id: string }>();
  for (const [index, cat] of CATEGORIES.entries()) {
    const slug = slugify(cat.name);
    const category = await prisma.menuCategory.upsert({
      where: { restaurantId_slug: { restaurantId, slug } },
      create: { restaurantId, name: cat.name, slug, type: cat.type, sortOrder: index },
      update: { name: cat.name, type: cat.type, sortOrder: index },
    });
    categoryBySlug.set(slug, category);
  }
  console.log(`✓ ${CATEGORIES.length} kategorija (upsert — bez duplikata pri ponovnom pokretanju)`);

  let created = 0;
  let updated = 0;
  let needsReviewCount = 0;

  for (const item of MENU_ITEMS) {
    const category = categoryBySlug.get(item.categorySlug);
    if (!category) {
      console.warn(`⚠️  Preskačem "${item.name}" — nepoznat categorySlug "${item.categorySlug}"`);
      continue;
    }

    const categoryMeta = CATEGORIES.find((c) => slugify(c.name) === item.categorySlug);
    const station: PreparationStationValue = categoryMeta?.type === "FOOD" ? "KITCHEN" : "BAR";
    const slug = slugify(item.name);

    const existing = await prisma.menuItem.findUnique({
      where: { restaurantId_slug: { restaurantId, slug } },
    });

    await prisma.menuItem.upsert({
      where: { restaurantId_slug: { restaurantId, slug } },
      create: {
        restaurantId,
        categoryId: category.id,
        name: item.name,
        slug,
        price: item.price ?? 0,
        preparationStation: station,
        needsReview: item.needsReview,
        reviewNote: item.reviewNote,
        isActive: !item.needsReview,
      },
      update: {
        categoryId: category.id,
        needsReview: item.needsReview,
        reviewNote: item.reviewNote,
        // Cena se NAMERNO ne prepisuje na update ako je vlasnik već uneo
        // stvarnu cenu kroz Admin Panel — ponovno pokretanje ove skripte
        // (npr. da doda nove artikle) ne sme obrisati već unete cene.
        // Zato price NIJE u update bloku (za razliku od create bloka).
      },
    });

    if (item.needsReview) needsReviewCount++;
    existing ? updated++ : created++;
  }

  console.log(`✓ Artikli: ${created} kreirano, ${updated} ažurirano`);
  console.log(`⚠️  ${needsReviewCount} artikala čeka unos cene u Admin Panelu (needsReview=true, isActive=false)`);
  console.log("✅ Uvoz menija završen.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
