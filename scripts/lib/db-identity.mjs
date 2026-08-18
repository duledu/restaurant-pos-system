// Plain-JS mirror of tests/setup/db-identity.ts, for backup/restore scripts
// that run as standalone node processes (not through the TS test runner).
// Keep this behaviorally identical to the .ts original — same comparison
// rules, same "test" name pattern — since both exist to answer the same
// question: "is it safe to point something destructive at this database?"

/** @returns {{host: string, port: string, database: string}} */
export function parseDbIdentity(connectionString) {
  const url = new URL(connectionString);
  return {
    host: url.hostname.toLowerCase(),
    port: url.port || "5432",
    database: url.pathname.replace(/^\//, "").toLowerCase(),
  };
}

export function sameDatabase(a, b) {
  const ia = parseDbIdentity(a);
  const ib = parseDbIdentity(b);
  return ia.host === ib.host && ia.port === ib.port && ia.database === ib.database;
}

const TEST_NAME_PATTERN = /(^|[_-])(test|drill|restore)([_-]|$)/i;

export function looksLikeSafeRestoreTargetName(database) {
  return TEST_NAME_PATTERN.test(database);
}

/** Never print a raw connection string — this is what every script logs instead. */
export function redactConnectionString(connectionString) {
  try {
    const id = parseDbIdentity(connectionString);
    return `${id.host}:${id.port}/${id.database}`;
  } catch {
    return "(unparseable connection string)";
  }
}
