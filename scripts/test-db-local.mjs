#!/usr/bin/env node
// Pokreće SAMO izolovanu lokalnu TEST bazu (migrirano + obeleženo marker
// tabelom) i ostaje u prvom planu dok se ne pritisne Ctrl+C. Korisno za
// ručno gađanje TEST baze (psql, Prisma Studio) ili za pokretanje
// `vitest run -c vitest.integration.config.ts` direktno u drugom terminalu
// bez da scripts/run-integration-tests.mjs sam podiže/gasi bazu svaki put.
import { startLocalTestPostgres, runTestMigrations, markAsTestDatabase, testDatabaseUrl } from "./lib/local-test-db.mjs";

async function main() {
  const pg = await startLocalTestPostgres();
  runTestMigrations();
  await markAsTestDatabase();

  console.log("");
  console.log(`[local-test-postgres] TEST_DATABASE_URL=${testDatabaseUrl()}`);
  console.log("[local-test-postgres] Baza radi. Ctrl+C za zaustavljanje.");

  const shutdown = async () => {
    console.log("\n[local-test-postgres] Zaustavljam ...");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[local-test-postgres] Greška:", err);
  process.exit(1);
});
