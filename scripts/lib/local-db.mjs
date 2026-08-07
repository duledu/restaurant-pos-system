// Self-contained lokalni Postgres za razvoj — NE dira postojeću sistemsku
// Postgres instalaciju (radi na sopstvenom portu/data direktorijumu preko
// `embedded-postgres`, koji preuzima i pokreće pravi Postgres binarni fajl
// bez Docker-a i bez sistemske instalacije/servisa).
//
// Koristi se preko scripts/db-local.mjs (samo baza) ili scripts/dev-local.mjs
// (baza + Next.js dev server) — vidi README "Local Installation (bez Dockera)".
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const LOCAL_DB = {
  host: "127.0.0.1",
  port: 55432,
  user: "rcs",
  password: "rcs_dev_password",
  database: "rcs_dev",
  databaseDir: path.join(ROOT, ".local-postgres-data"),
};

export function localDatabaseUrl() {
  const { user, password, host, port, database } = LOCAL_DB;
  return `postgresql://${user}:${password}@${host}:${port}/${database}?schema=public`;
}

/**
 * Pokreće (i po potrebi inicijalizuje) embedded Postgres klaster. Podaci se
 * čuvaju u .local-postgres-data/ (gitignored) i preživljavaju restart —
 * "prvo pokretanje" logika ispod pokreće initdb/createDatabase samo jednom.
 */
export async function startLocalPostgres() {
  const firstRun = !existsSync(path.join(LOCAL_DB.databaseDir, "PG_VERSION"));

  const pg = new EmbeddedPostgres({
    databaseDir: LOCAL_DB.databaseDir,
    user: LOCAL_DB.user,
    password: LOCAL_DB.password,
    port: LOCAL_DB.port,
    persistent: true,
    // initdb na Windows-u nasleđuje OS codepage (npr. WIN1252) kao podrazumevani
    // encoding ako se izričito ne navede — šema/seed sadrže ćirilične/latinične
    // dijakritike (č, š, ž ...) koje WIN1252 ne ume da predstavi, pa migracija
    // pada na "character ... has no equivalent in encoding WIN1252". "C" lokal
    // izbegava zavisnost od lokala instaliranih na sistemu (nije nam bitno
    // lokalizovano sortiranje za dev bazu), uz eksplicitni UTF8 encoding.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: (message) => {
      // Postgres-ov stdout je vrlo opširan za svaki upit — prosleđujemo samo
      // greške (onError ispod); ovde namerno tiho.
      void message;
    },
    onError: (message) => console.error("[local-postgres]", message),
  });

  if (firstRun) {
    console.log("[local-postgres] Prvo pokretanje — inicijalizujem klaster u .local-postgres-data/ ...");
    await pg.initialise();
  }

  await pg.start();

  if (firstRun) {
    await pg.createDatabase(LOCAL_DB.database);
    console.log(`[local-postgres] Baza "${LOCAL_DB.database}" kreirana.`);
  }

  console.log(`[local-postgres] Spreman na ${localDatabaseUrl()}`);
  return pg;
}

function runInPackagesDb(npmScript, extraEnv) {
  const result = spawnSync("npm", ["run", npmScript], {
    cwd: path.join(ROOT, "packages", "db"),
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: localDatabaseUrl(), ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`"npm run ${npmScript}" (packages/db) nije uspeo (exit ${result.status})`);
  }
}

export function runMigrations() {
  console.log("[local-postgres] Primenjujem Prisma migracije ...");
  runInPackagesDb("migrate:deploy");
}

/**
 * Seed je NE-idempotentan (seed.ts pravi fiksne redove, drugi poziv bi pao
 * na unique constraint) — zato prvo proveravamo da li dev nalozi već
 * postoje i preskačemo ako da, umesto da seed.ts to sam rešava. Meni
 * (seed-menu.ts) je ODVOJEN korak — vidi napomenu u seed.ts zašto — pa se
 * proverava/pokreće nezavisno, čak i ako su nalozi već tu (npr. nakon što
 * su integration testovi TRUNCATE-ovali samo deo šeme).
 */
export async function seedIfEmpty() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: localDatabaseUrl() });
  await client.connect();
  try {
    const usersRes = await client.query(`SELECT 1 FROM users WHERE email = 'owner@dev.local' LIMIT 1`);
    if ((usersRes.rowCount ?? 0) > 0) {
      console.log("[local-postgres] Dev nalozi već postoje — preskačem seed.");
    } else {
      console.log("[local-postgres] Seed-ujem dev naloge ...");
      runInPackagesDb("seed", { NODE_ENV: "development" });
    }

    const restaurantRes = await client.query(
      `SELECT r.id FROM restaurants r JOIN tenants t ON t.id = r."tenantId" WHERE t.slug = 'dev-tenant' LIMIT 1`
    );
    const restaurantId = restaurantRes.rows[0]?.id;
    if (!restaurantId) {
      console.warn('[local-postgres] Nije pronađen dev restoran (tenant slug "dev-tenant") — preskačem uvoz menija.');
      return;
    }

    const menuRes = await client.query(`SELECT 1 FROM menu_categories WHERE "restaurantId" = $1 LIMIT 1`, [
      restaurantId,
    ]);
    if ((menuRes.rowCount ?? 0) > 0) {
      console.log("[local-postgres] Meni već uvezen — preskačem.");
      return;
    }

    console.log("[local-postgres] Uvozim meni (16 kategorija / 137 artikala) ...");
    runInPackagesDb("seed:menu", { RESTAURANT_ID: restaurantId });
  } finally {
    await client.end();
  }
}
