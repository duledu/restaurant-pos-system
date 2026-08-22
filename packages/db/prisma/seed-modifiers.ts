/**
 * P3.2 — MALI, IDEMPOTENTNI dev-seed za grupe/opcije dodataka.
 *
 * NAMERNO ne vezuje grupe za konkretne artikle menija: seed-menu.ts uvozi
 * 137 artikala kao needsReview=true/isActive=false dok vlasnik ne unese
 * stvarne cene (vidi napomenu tamo), a tačni nazivi (npr. "Pljeskavica 200 g")
 * nisu pouzdan cilj za automatsko vezivanje. Ova skripta samo kreira
 * REUSABLE grupe/opcije (biblioteku) — vlasnik/menadžer ih veže za
 * konkretne artikle kroz Admin → Meni → Dodaci (vidi modifiers-client.tsx).
 *
 * Idempotentno: find-by-name-pa-create (nema @@unique na ModifierGroup.name
 * jer isti naziv grupe je legitiman u različitim restoranima/varijantama —
 * ponovno pokretanje NE pravi duplikate JER prvo proverava da li grupa sa
 * tim nazivom već postoji za dati restoran).
 *
 * POKRETANJE:
 *   RESTAURANT_ID=<id> npx ts-node prisma/seed-modifiers.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface OptionSeed {
  name: string;
  priceDelta: number;
}
interface GroupSeed {
  name: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  options: OptionSeed[];
}

const GROUPS: GroupSeed[] = [
  {
    name: "Dodaci",
    required: false,
    minSelect: 0,
    maxSelect: 5,
    options: [
      { name: "Kačkavalj", priceDelta: 100 },
      { name: "Slanina", priceDelta: 150 },
      { name: "Jaje", priceDelta: 80 },
    ],
  },
  {
    name: "Veličina",
    required: true,
    minSelect: 1,
    maxSelect: 1,
    options: [
      { name: "Mala", priceDelta: 0 },
      { name: "Velika", priceDelta: 250 },
    ],
  },
  {
    name: "Prilozi",
    required: false,
    minSelect: 0,
    maxSelect: 3,
    options: [
      { name: "Bez luka", priceDelta: 0 },
      { name: "Bez paradajza", priceDelta: 0 },
    ],
  },
];

async function main() {
  const restaurantId = process.env.RESTAURANT_ID;
  if (!restaurantId) {
    console.error("Greška: postavi RESTAURANT_ID environment promenljivu pre pokretanja.");
    console.error("Primer: RESTAURANT_ID=<id> npx ts-node prisma/seed-modifiers.ts");
    process.exit(1);
  }

  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) {
    console.error(`Restoran sa id=${restaurantId} ne postoji.`);
    process.exit(1);
  }
  console.log(`Seed dodataka za restoran: ${restaurant.name} (${restaurant.id})`);

  let groupsCreated = 0;
  let optionsCreated = 0;

  for (const [index, groupSeed] of GROUPS.entries()) {
    let group = await prisma.modifierGroup.findFirst({ where: { restaurantId, name: groupSeed.name } });
    if (!group) {
      group = await prisma.modifierGroup.create({
        data: {
          restaurantId,
          name: groupSeed.name,
          required: groupSeed.required,
          minSelect: groupSeed.minSelect,
          maxSelect: groupSeed.maxSelect,
          sortOrder: index,
        },
      });
      groupsCreated++;
    }

    for (const [optIndex, optionSeed] of groupSeed.options.entries()) {
      const existingOption = await prisma.modifierOption.findFirst({
        where: { modifierGroupId: group.id, name: optionSeed.name },
      });
      if (!existingOption) {
        await prisma.modifierOption.create({
          data: {
            modifierGroupId: group.id,
            name: optionSeed.name,
            priceDelta: optionSeed.priceDelta,
            sortOrder: optIndex,
          },
        });
        optionsCreated++;
      }
    }
  }

  console.log(`✓ Grupe: ${groupsCreated} kreirano (od ${GROUPS.length} ukupno u seed listi)`);
  console.log(`✓ Opcije: ${optionsCreated} kreirano`);
  console.log("✅ Seed dodataka završen. Veži grupe za artikle kroz Admin → Meni → Dodaci.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
