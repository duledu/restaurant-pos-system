// Četiri stara integration testa (menu-upsert-idempotency, shifts-orders,
// station-state, tenant-isolation) su potpuno samostalna — ne uvoze @rcs/db,
// već otvaraju SOPSTVENI raw `pg.Client` prema `TEST_DATABASE_URL`, sa
// fallback-om na lokalni embedded Postgres (scripts/lib/local-db.mjs) koji
// ovde nije pokrenut. Bez TEST_DATABASE_URL-a ta 4 fajla dosledno padaju na
// ECONNREFUSED (pokušavaju localhost:5432, ništa tamo ne sluša). Rešenje:
// upute ih na ISTU (Neon) bazu koju već koriste ostala 24 integration
// fajla preko @rcs/db — nema potrebe za drugom bazom niti za pokretanjem
// embedded Postgres-a samo za ova 4 fajla.
if (process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) {
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
}

// Vitest daje SVAKOM test fajlu izolovan modul-registar, pa
// tests/integration/*.test.ts uvozi @rcs/db 28 puta nezavisno — svaki uvoz
// pravi SOPSTVENI PrismaClient sa podrazumevanom veličinom pool-a
// (num_cpus*2+1, tipično 9-17 konekcija). Iako vitest.config.ts serijalizuje
// IZVRŠAVANJE testova (fileParallelism:false), Vitest svejedno UVOZI/kolektuje
// module za sve fajlove pre pokretanja, a $disconnect() jednog fajla i
// otvaranje pool-a sledećeg mogu da se preklope na udaljenom Neon endpoint-u
// (mrežna latencija zatvaranja konekcije). Kumulativno to premašuje Neon
// pooler-ov limit konekcija i vraća ECONNREFUSED nasumičnim fajlovima.
//
// Ograničavamo pool PO FAJLU na mali broj — dovoljno za sekvencijalne
// testove u jednom fajlu, dovoljno malo da 28 fajlova zajedno ne probije
// limit čak i uz privremeno preklapanje pri tranziciji između fajlova.
if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("connection_limit")) {
  const separator = process.env.DATABASE_URL.includes("?") ? "&" : "?";
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}${separator}connection_limit=3&pool_timeout=20`;
}
