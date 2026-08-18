#!/usr/bin/env node
// Pokreće tests/integration/* protiv IZOLOVANE test baze.
//
// Podrazumevano (bez ikakve konfiguracije): podiže sopstveni embedded
// Postgres (scripts/lib/local-test-db.mjs, port 55433, baza "rcs_test",
// potpuno odvojen od DEV baze na 55432 i od bilo kog Neon DATABASE_URL-a),
// primenjuje migracije, obeležava ga marker tabelom i tek onda pokreće
// vitest — testovi FIZIČKI ne mogu pogoditi DEV/PROD jer se povezuju na
// drugi port/proces koji ovaj skript sam kontroliše.
//
// Ako je TEST_DATABASE_URL već eksplicitno postavljen u okruženju (npr. CI
// koji koristi posebnu Neon "test" granu) — ne diramo ga, samo prosleđujemo
// dalje. tests/setup/require-test-database.ts će svejedno odbiti da
// nastavi ako ta baza nije i dalje obeležena marker tabelom
// (`npm run test:db:mark` je jednokratni korak za takav scenario).
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { startLocalTestPostgres, runTestMigrations, markAsTestDatabase, testDatabaseUrl } from "./lib/local-test-db.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const externallyProvided = Boolean(process.env.TEST_DATABASE_URL);
  let pg;
  let testUrl = process.env.TEST_DATABASE_URL;

  if (!externallyProvided) {
    console.log("[test-integration] TEST_DATABASE_URL nije postavljen — podižem izolovanu lokalnu test bazu ...");
    pg = await startLocalTestPostgres();
    runTestMigrations();
    await markAsTestDatabase();
    testUrl = testDatabaseUrl();
  } else {
    console.log(`[test-integration] Koristim eksplicitno postavljen TEST_DATABASE_URL.`);
  }

  try {
    const result = spawnSync("npx", ["vitest", "run", "-c", "vitest.integration.config.ts"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
      env: { ...process.env, TEST_DATABASE_URL: testUrl },
    });
    return result.status ?? 1;
  } finally {
    if (pg) {
      console.log("[test-integration] Zaustavljam lokalnu test bazu ...");
      await pg.stop();
    }
  }
}

// NAPOMENA: embedded-postgres registruje sopstveni `async-exit-hook` koji
// presreće `process.exit()` da bi async-zatvorio klaster PRE stvarnog izlaza
// — to može "progutati" `process.exitCode` postavljen na uobičajen način.
// Zato ovde EKSPLICITNO zovemo `process.exit(code)` sa tačnim kodom, umesto
// da se oslanjamo na to da Node sam iskoristi `process.exitCode` na kraju
// event loop-a — bitno za CI/`npm run test`, koji MORA da vidi neuspeh testova
// kao neuspeh cele komande, ne kao (pogrešan) exit 0.
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[test-integration] Greška:", err);
    process.exit(1);
  });
