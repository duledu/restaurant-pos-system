/**
 * SAFETY GATE — vitest setupFiles entry (vitest.integration.config.ts),
 * učitava se PRE bilo kog tests/integration/*.test.ts fajla.
 *
 * Sprečava ponavljanje incidenta iz avgusta 2026: integration testovi su
 * koristili istu Neon bazu kao pokrenuta razvojna aplikacija i
 * `TRUNCATE ... CASCADE` u beforeEach je obrisao korisnike i istorijske
 * podatke restorana. Vidi docs/database-safety.md za punu analizu.
 *
 * Sama provera (assertTestDatabaseIsSafe) je namerno u odvojenom fajlu bez
 * top-level side effect-a, da bi mogla da se unit-testira sa kontrolisanim
 * process.env vrednostima — vidi tests/unit/assert-test-database.test.ts.
 * Ovaj fajl je tanka omotnica: pokreće proveru PRI UČITAVANJU i, tek nakon
 * što prođe, preusmerava DATABASE_URL/DIRECT_URL na TEST_DATABASE_URL za
 * trajanje ovog test procesa — Prisma klijent (@rcs/db) i svi raw `pg`
 * klijenti u tests/integration/* otad gledaju ISKLJUČIVO test bazu.
 */
import { assertTestDatabaseIsSafe } from "./assert-test-database";

const verifiedTestUrl = await assertTestDatabaseIsSafe();

process.env.DATABASE_URL = verifiedTestUrl;
process.env.DIRECT_URL = verifiedTestUrl;

// ── Connection pool tuning (nasleđeno iz starog limit-db-connections.ts) ──
//
// Vitest daje SVAKOM test fajlu izolovan modul-registar, pa tests/integration/*
// koji uvoze @rcs/db svaki prave SOPSTVENI PrismaClient sa podrazumevanom
// veličinom pool-a. Iako vitest.integration.config.ts serijalizuje
// IZVRŠAVANJE testova (fileParallelism:false), Vitest svejedno uvozi/kolektuje
// module za sve fajlove pre pokretanja, pa se otvaranje/zatvaranje pool-ova
// više fajlova može privremeno preklopiti. Za lokalnu embedded test bazu ovo
// praktično nije problem (nema pooler limita), ali ostaje bezopasna zaštita
// i za slučaj da je TEST_DATABASE_URL podešen na udaljenu (npr. Neon test
// grana) bazu.
if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("connection_limit")) {
  const separator = process.env.DATABASE_URL.includes("?") ? "&" : "?";
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}${separator}connection_limit=5&pool_timeout=20`;
}
