/**
 * Jednokratni (idempotentan) korak za slučaj kad TEST_DATABASE_URL pokazuje
 * na EKSTERNO obezbeđenu bazu (npr. posebna Neon "test" grana), a ne na
 * lokalni embedded Postgres koji scripts/run-integration-tests.mjs sam
 * podiže i obeležava.
 *
 * Odbija da obeleži bilo šta ako:
 *   - TEST_DATABASE_URL nije postavljen,
 *   - ime baze ne sadrži "test",
 *   - TEST_DATABASE_URL se poklapa (host+port+ime baze) sa DATABASE_URL/DIRECT_URL.
 *
 * Ovo NIJE zaobilazak bezbednosne provere — to je alat koji sam sprovodi
 * ISTU proveru pre nego što upiše marker koji require-test-database.ts
 * kasnije čita.
 *
 * Pokreni: npx tsx scripts/mark-test-database.ts
 */
import { Client } from "pg";
import { looksLikeTestDatabaseName, parseDbIdentity, sameDatabase } from "../tests/setup/db-identity";

const MARKER_TABLE = "_rcs_test_database_marker";

async function main() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL nije postavljen.");
  }

  for (const [name, value] of [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["DIRECT_URL", process.env.DIRECT_URL],
  ] as const) {
    if (value && sameDatabase(testUrl, value)) {
      throw new Error(
        `TEST_DATABASE_URL se poklapa sa ${name} — odbijam da obeležim. Ovo bi upravo dozvolilo destruktivnim ` +
          "testovima da rade protiv DEV/PROD baze."
      );
    }
  }

  const { database } = parseDbIdentity(testUrl);
  if (!looksLikeTestDatabaseName(database)) {
    throw new Error(
      `Ime baze "${database}" ne sadrži "test" — odbijam da obeležim. Preimenuj bazu ili koristi drugu, ` +
        "čije ime nedvosmisleno signalizira da je namenjena testovima."
    );
  }

  const client = new Client({ connectionString: testUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
        id BOOLEAN PRIMARY KEY DEFAULT true,
        labeled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ${MARKER_TABLE}_singleton CHECK (id)
      )
    `);
    await client.query(`INSERT INTO ${MARKER_TABLE} (id) VALUES (true) ON CONFLICT (id) DO NOTHING`);
    console.log(`✅  Baza "${database}" obeležena kao test baza (${MARKER_TABLE}).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
