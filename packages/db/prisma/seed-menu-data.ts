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

// Redosled niza = sortOrder. Nazivi kategorija na srpskom latiničnom pismu.
export const CATEGORIES: CategorySeed[] = [
  { name: "Doručak",              type: "FOOD" },
  { name: "Hladna predjela",      type: "FOOD" },
  { name: "Topla predjela",       type: "FOOD" },
  { name: "Roštilj",             type: "FOOD" },
  { name: "Jela po narudžbini",  type: "FOOD" },
  { name: "Salate",               type: "FOOD" },
  { name: "Zimske salate",        type: "FOOD" },
  { name: "Riba",                 type: "FOOD" },
  { name: "Hleb",                 type: "FOOD" },
  { name: "Deserti",              type: "FOOD" },
  { name: "Topli napici",         type: "DRINK" },
  { name: "Bezalkoholna pića",    type: "DRINK" },
  { name: "Voda",                 type: "DRINK" },
  { name: "Pivo",                 type: "DRINK" },
  { name: "Žestoka pića",         type: "DRINK" },
  { name: "Vino",                 type: "DRINK" },
];

export const REVIEW_NOTE =
  "Cena nije dostavljena sa zvaničnog menija — uneti kroz Admin Panel (Meni → klik na cenu) pre aktiviranja artikla.";

// Nazivi artikala tačno kako su dostavljeni. Ključevi su slugovi kategorija
// koji moraju da odgovaraju slugify(category.name) iz CATEGORIES niza iznad.
export const MENU_BY_CATEGORY: Record<string, string[]> = {
  dorucak: ["Pileća čorba", "Omlet", "Omlet sa sirom", "Omlet sa šunkom", "Omlet sa slaninom"],
  "hladna-predjela": ["Ordever"],
  "topla-predjela": [
    "Pohovani kačkavalj",
    "Pohovana zdenka",
    "Pomfrit",
    "Pomfrit sa sirom",
    "Pečurke na žaru",
    "Pohovane pečurke",
    "Grilovano povrće",
    "Topla daska",
  ],
  rostilj: [
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
  "jela-po-naruzbini": [
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
  salate: [
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
  "zimske-salate": [
    "Mešana zimska salata",
    "Zimski kupus",
    "Krompir salata",
    "Cvekla",
    "Ajvar",
    "Trljanica",
    "Paprika u pavlaci",
  ],
  riba: ["Pastrmka", "Škarpina"],
  hleb: ["Lepinja", "Lepinja sa sirom"],
  deserti: ["Palačinka sa kremom"],
  "topli-napici": ["Espresso", "Čaj"],
  "bezalkoholna-pica": [
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
  voda: ["Rosa 0.33", "Rosa 0.75", "Bivoda 0.20", "Bivoda 1 l", "Heba", "BiAqua"],
  pivo: [
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
  "zestoka-pica": [
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
  vino: [
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

