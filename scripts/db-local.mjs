#!/usr/bin/env node
// Pokreće SAMO lokalnu embedded Postgres bazu (migrirano + seed-ovano) i
// ostaje u prvom planu dok se ne pritisne Ctrl+C. Korisno za pokretanje
// testova (tests/integration/*) ili ručno gađanje API-ja bez Next.js
// dev servera. Za punu aplikaciju koristi `npm run dev:local`.
import { startLocalPostgres, runMigrations, seedIfEmpty, localDatabaseUrl } from "./lib/local-db.mjs";

async function main() {
  const pg = await startLocalPostgres();
  runMigrations();
  await seedIfEmpty();

  console.log("");
  console.log(`[local-postgres] DATABASE_URL=${localDatabaseUrl()}`);
  console.log("[local-postgres] Baza radi. Ctrl+C za zaustavljanje.");

  const shutdown = async () => {
    console.log("\n[local-postgres] Zaustavljam ...");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[local-postgres] Greška:", err);
  process.exit(1);
});
