/**
 * Podaci menija — izdvojeni iz seed-menu.ts u poseban modul BEZ zavisnosti
 * od @prisma/client, da bi testovi (tests/integration/menu-upsert-*) mogli
 * da uvezu iste podatke bez pokretanja Prisma klijenta ili konekcije na
 * bazu. seed-menu.ts uvozi ove podatke i primenjuje ih preko Prisma
 * upsert-a; ovaj fajl je čisti izvor istine za "šta je na meniju".
 */

export type CategoryTypeValue = "FOOD" | "DRINK";
export type PreparationStationValue = "KITCHEN" | "BAR" | "KITCHEN_AND_BAR" | "NONE";

export function slugify(input: string): string {
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

export interface CategorySeed {
  name: string;
  type: CategoryTypeValue;
}

// Redosled niza = sortOrder. Tačno kategorije iz zahteva, bez izmena naziva.
export const CATEGORIES: CategorySeed[] = [
  { name: "Breakfast", type: "FOOD" },
  { name: "Cold Appetizers", type: "FOOD" },
  { name: "Hot Appetizers", type: "FOOD" },
  { name: "Grill", type: "FOOD" },
  { name: "Made To Order", type: "FOOD" },
  { name: "Salads", type: "FOOD" },
  { name: "Winter Salads", type: "FOOD" },
  { name: "Fish", type: "FOOD" },
  { name: "Bread", type: "FOOD" },
  { name: "Desserts", type: "FOOD" },
  { name: "Hot Drinks", type: "DRINK" },
  { name: "Soft Drinks", type: "DRINK" },
  { name: "Water", type: "DRINK" },
  { name: "Beer", type: "DRINK" },
  { name: "Spirits", type: "DRINK" },
  { name: "Wine", type: "DRINK" },
];

export const REVIEW_NOTE =
  "Cena nije dostavljena sa zvaničnog menija — uneti kroz Admin Panel (Meni → klik na cenu) pre aktiviranja artikla.";

// Nazivi tačno kako su dostavljeni — bez prevoda, skraćivanja ili izmene
// (uključujući gramature koje su deo naziva, npr. "Pljeskavica 200 g", jer
// je tako navedeno na meniju, ne kao odvojeno structured polje).
export const MENU_BY_CATEGORY: Record<string, string[]> = {
  breakfast: ["Pileća čorba", "Omlet", "Omlet sa sirom", "Omlet sa šunkom", "Omlet sa slaninom"],
  "cold-appetizers": ["Ordever"],
  "hot-appetizers": [
    "Pohovani kačkavalj",
    "Pohovana zdenka",
    "Pomfrit",
    "Pomfrit sa sirom",
    "Pečurke na žaru",
    "Pohovane pečurke",
    "Grilovano povrće",
    "Topla daska",
  ],
  grill: [
    "Ćevap",
    "Pljeskavica 200 g",
    "Pljeskavica 300 g",
    "Gurmanska pljeskavica 200 g",
    "Gurmanska pljeskavica 300 g",
    "Punjena pljeskavica 200 g",
    "Punjena pljeskavica 300 g",
    "Punjena pljeskavica (kajmak i pršuta) 200 g",
    "Punjena pljeskavica (kajmak i pršuta) 300 g",
    "Uštipak",
    "Ćevapi u kajmaku",
    "Pileće belo",
    "Punjeno pileće belo",
    "Pileći batak",
    "Dimljeni batak",
    "Bečka šnicla (pileća)",
    "Bečka šnicla (svinjska)",
  ],
  "made-to-order": [
    "Pileći prsti",
    "Pileća krilca",
    "Pileća Karađorđeva",
    "Pileći ražnjić",
    "Pileći ražnjić sa pršutom",
    "Pileći ražnjić sa slaninom",
    "Vešalica",
    "Punjena vešalica",
    "Svinjski ražnjić",
    "Svinjska kremenadla",
    "Dimljeni svinjski vrat",
    "Biftek",
    "Ramstek",
    "Teletina u sosu",
    "Goveđa kobasica",
    "Svinjska kobasica",
    "Svinjski file",
  ],
  salads: [
    "Srpska salata",
    "Šopska salata",
    "Grčka salata",
    "Mešana salata",
    "Krastavac salata",
    "Paradajz salata",
    "Kupus salata",
    "Vitaminska salata",
    "Urnebes salata",
    "Moravska salata",
    "Kravlji sir",
    "Kajmak",
    "Masline",
    "Ljuta papričica",
  ],
  "winter-salads": [
    "Mešana zimska salata",
    "Zimski kupus",
    "Krompir salata",
    "Cvekla",
    "Ajvar",
    "Trljanica",
    "Paprika u pavlaci",
  ],
  fish: ["Pastrmka", "Škarpina"],
  bread: ["Lepinja", "Lepinja sa sirom"],
  desserts: ["Palačinka sa kremom"],
  "hot-drinks": ["Espresso", "Čaj"],
  "soft-drinks": [
    "Coca-Cola",
    "Coca-Cola Zero",
    "Fanta",
    "Sprite",
    "Schweppes Bitter Lemon",
    "Schweppes Tonic",
    "Jaffa",
    "Cedevita",
    "Ice Tea",
    "Ultra Energy",
    "Red Bull",
  ],
  water: ["Rosa 0.33", "Rosa 0.75", "Bivoda 0.20", "Bivoda 1 l", "Heba", "BiAqua"],
  beer: [
    "Zaječarsko 0.33",
    "Zaječarsko 0.50",
    "Pils",
    "Heineken 0.25",
    "Heineken 0.40",
    "Heineken 0.0",
    "Birra Moretti",
    "Laško 0.33",
    "Laško 0.50",
    "Niško",
    "Jelen",
    "Nikšićko",
    "Staropramen",
    "Bavaria",
    "Stella Artois",
  ],
  spirits: [
    "Šljivovica",
    "Dunjevača",
    "Žolta Tikveš",
    "Vinjak",
    "Ouzo",
    "Stomaklija",
    "Vodka",
    "Viljamovka",
    "Gorki List",
    "Stock",
    "Johnnie Walker",
    "Jack Daniel's",
    "Gin",
    "Jagermeister",
    "Medovača",
    "Badel",
  ],
  wine: [
    "Graševina",
    "Smederevka",
    "Ždrepčeva krv",
    "Rose Tikveš",
    "Aleksandrija Belo",
    "Aleksandrija Crveno",
    "Tamjanika",
    "Tamjanika 0.187",
    "Aleksandrija Belo 0.187",
    "Aleksandrija Crveno 0.187",
    "Rose Tikveš 0.187",
    "Vermouth",
    "Somersby",
  ],
};

