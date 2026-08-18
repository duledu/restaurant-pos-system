/**
 * Sama provera (bez ijednog top-level side effect-a pri importu) — izdvojena
 * iz require-test-database.ts da bi bila unit-testabilna sa kontrolisanim
 * process.env vrednostima, vidi tests/unit/assert-test-database.test.ts.
 * require-test-database.ts (vitest setupFile) je tanka omotnica koja ovo
 * poziva PRI UČITAVANJU i postavlja DATABASE_URL/DIRECT_URL na rezultat.
 */
import { Client } from "pg";
import { looksLikeTestDatabaseName, parseDbIdentity, sameDatabase } from "./db-identity";

export const MARKER_TABLE = "_rcs_test_database_marker";

class DbSafetyError extends Error {}

function abort(message: string): never {
  const banner = "=".repeat(70);
  console.error(`\n${banner}\n🛑 TEST DATABASE SAFETY CHECK FAILED — test run aborted\n${banner}\n${message}\n${banner}\n`);
  throw new DbSafetyError(`[db-safety] ${message}`);
}

export interface AssertTestDatabaseDeps {
  /** Injektovano radi unit testova — izbegava pravu mrežnu konekciju. */
  connect?: (connectionString: string) => Promise<{ marked: boolean }>;
}

async function checkMarkerViaLiveConnection(connectionString: string): Promise<{ marked: boolean }> {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const res = await client.query<{ marked: boolean }>(
      `SELECT to_regclass('public.${MARKER_TABLE}') IS NOT NULL AS marked`
    );
    return { marked: Boolean(res.rows[0]?.marked) };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function assertTestDatabaseIsSafe(deps: AssertTestDatabaseDeps = {}): Promise<string> {
  const testUrl = process.env.TEST_DATABASE_URL;

  if (!testUrl) {
    abort(
      "TEST_DATABASE_URL nije postavljen. Integration testovi rade TRUNCATE ... CASCADE i NIKAD ne " +
        "smeju pogoditi DEVELOPMENT ili PRODUCTION bazu. Pokreni `npm run test:integration` (automatski " +
        "podiže izolovanu lokalnu test bazu) ili eksplicitno postavi TEST_DATABASE_URL na posebnu, već " +
        "obeleženu test bazu — vidi docs/database-safety.md."
    );
  }

  for (const [name, value] of [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["DIRECT_URL", process.env.DIRECT_URL],
  ] as const) {
    if (value && sameDatabase(testUrl, value)) {
      abort(
        `TEST_DATABASE_URL pokazuje na ISTU bazu kao ${name}. Ovo je TAČNO scenario koji je izazvao ` +
          "gubitak podataka u avgustu 2026 — testovi NIKAD ne smeju raditi protiv baze koju koristi " +
          "razvojna/produkciona aplikacija. Postavi TEST_DATABASE_URL na posebnu, disposable test bazu."
      );
    }
  }

  let database: string;
  try {
    database = parseDbIdentity(testUrl).database;
  } catch {
    abort("TEST_DATABASE_URL nije validan connection string.");
  }

  if (!looksLikeTestDatabaseName(database!)) {
    abort(
      `TEST_DATABASE_URL cilja bazu "${database!}" čije ime ne sadrži "test" kao odvojenu reč. Ovo je ` +
        "namerna bezbednosna provera — ime baze koja prima TRUNCATE CASCADE mora nedvosmisleno " +
        "signalizirati da je test baza."
    );
  }

  try {
    const { marked } = await (deps.connect ?? checkMarkerViaLiveConnection)(testUrl);
    if (!marked) {
      abort(
        `Baza na koju TEST_DATABASE_URL pokazuje NIJE eksplicitno obeležena kao test baza (nedostaje ` +
          `"${MARKER_TABLE}" tabela). Pokreni \`npm run test:db:mark\` da je obeležiš — ovo je namerna ` +
          "dvostruka provera, ne oslanjamo se samo na ime env promenljive."
      );
    }
  } catch (err) {
    if (err instanceof DbSafetyError) throw err;
    abort(`Ne mogu da se povežem na TEST_DATABASE_URL da proverim marker tabelu: ${(err as Error).message}`);
  }

  return testUrl;
}
