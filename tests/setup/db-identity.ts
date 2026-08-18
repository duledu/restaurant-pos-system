/**
 * Čiste (bez mrežnih poziva) funkcije za poređenje/proveru connection
 * string-ova, izdvojene iz require-test-database.ts da bi bile unit-
 * testabilne bez žive DB konekcije — vidi tests/unit/db-identity.test.ts.
 */

export interface DbIdentity {
  host: string;
  port: string;
  database: string;
}

/** Baza je "ista" ako se poklapaju host+port+ime baze — kredencijali i
 * query parametri (sslmode, pgbouncer, connection_limit ...) se namerno
 * ignorišu jer ne menjaju NA KOJI fizički Postgres se upit šalje. */
export function parseDbIdentity(connectionString: string): DbIdentity {
  const url = new URL(connectionString);
  return {
    host: url.hostname.toLowerCase(),
    port: url.port || "5432",
    database: url.pathname.replace(/^\//, "").toLowerCase(),
  };
}

export function sameDatabase(a: string, b: string): boolean {
  const ia = parseDbIdentity(a);
  const ib = parseDbIdentity(b);
  return ia.host === ib.host && ia.port === ib.port && ia.database === ib.database;
}

// Ime baze koja prima TRUNCATE CASCADE mora nedvosmisleno signalizirati da
// je test baza — "rcs_test", "test_db", "my-test" prolaze; "rcs_dev",
// "production", "contest_data" (namerno) NE prolaze jer "test" nije
// odvojena reč.
const TEST_NAME_PATTERN = /(^|[_-])test([_-]|$)/i;

export function looksLikeTestDatabaseName(database: string): boolean {
  return TEST_NAME_PATTERN.test(database);
}
