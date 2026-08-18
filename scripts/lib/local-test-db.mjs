// Self-contained lokalni Postgres NAMENJEN ISKLJUČIVO automatizovanim
// testovima — potpuno odvojen proces/port/data-direktorijum/kredencijali od
// scripts/lib/local-db.mjs (koji je DEV baza, `rcs_dev` na portu 55432).
//
// Ova odvojenost je NAMERNA arhitektonska odluka (vidi docs/database-safety.md):
// TEST baza mora biti STRUKTURNO nemoguće zameniti sa DEV/PROD bazom, ne
// samo "po konvenciji imenovanja env promenljive". Različit port + različit
// data direktorijum + različiti kredencijali znače da čak i potpuno pogrešno
// podešen DATABASE_URL ne može slučajno da se poklopi sa TEST_DATABASE_URL.
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const TEST_DB = {
  host: "127.0.0.1",
  port: 55433, // NAMERNO različit od DEV (55432) — vidi napomenu na vrhu fajla.
  user: "rcs_test",
  password: "rcs_test_password",
  database: "rcs_test",
  databaseDir: path.join(ROOT, ".local-postgres-data-test"),
};

// Marker tabela koju NIKAD ne kreira Prisma migracija — ovo je namerno van
// šeme aplikacije. Prisustvo ove tabele (sa ovim tačno određenim redom) je
// DRUGI, nezavisni bezbednosni mehanizam (pored TEST_DATABASE_URL env
// promenljive) koji tests/setup/require-test-database.ts proverava PRE
// svake destruktivne operacije — vidi docs/database-safety.md #2.
const MARKER_TABLE = "_rcs_test_database_marker";

export function testDatabaseUrl() {
  const { user, password, host, port, database } = TEST_DB;
  return `postgresql://${user}:${password}@${host}:${port}/${database}?schema=public`;
}

export async function startLocalTestPostgres() {
  const firstRun = !existsSync(path.join(TEST_DB.databaseDir, "PG_VERSION"));

  const pg = new EmbeddedPostgres({
    databaseDir: TEST_DB.databaseDir,
    user: TEST_DB.user,
    password: TEST_DB.password,
    port: TEST_DB.port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: (message) => console.error("[local-test-postgres]", message),
  });

  if (firstRun) {
    console.log("[local-test-postgres] Prvo pokretanje — inicijalizujem TEST klaster u .local-postgres-data-test/ ...");
    await pg.initialise();
  }

  await pg.start();

  if (firstRun) {
    await pg.createDatabase(TEST_DB.database);
    console.log(`[local-test-postgres] Baza "${TEST_DB.database}" kreirana.`);
  }

  console.log(`[local-test-postgres] Spreman na ${testDatabaseUrl()}`);
  return pg;
}

export function runTestMigrations() {
  console.log("[local-test-postgres] Primenjujem Prisma migracije na TEST bazu ...");
  const result = spawnSync("npm", ["run", "migrate:deploy"], {
    cwd: path.join(ROOT, "packages", "db"),
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      DIRECT_URL: testDatabaseUrl(),
    },
  });
  if (result.status !== 0) {
    throw new Error(`"npm run migrate:deploy" (packages/db, TEST baza) nije uspeo (exit ${result.status})`);
  }
}

/**
 * Upisuje marker koji tests/setup/require-test-database.ts proverava kao
 * DRUGI (ne-env-var) dokaz da je ciljna baza zaista namenjena testovima.
 * Idempotentno — bezbedno pozvati na svako pokretanje.
 */
export async function markAsTestDatabase(connectionString = testDatabaseUrl()) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
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
  } finally {
    await client.end();
  }
}

export { MARKER_TABLE };
