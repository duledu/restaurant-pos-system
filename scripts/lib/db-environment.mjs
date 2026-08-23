// Explicit PRODUCTION / DEVELOPMENT / TEST database identity marker —
// same architecture as the existing TEST-database marker
// (tests/setup/assert-test-database.ts, scripts/mark-test-database.ts):
// a singleton marker table, checked live against the actual target
// database, never inferred from things that aren't a real safety boundary
// (restaurant name, database display name, env var name alone).
//
// Why this exists: TableCore had Development and Production sharing the
// same Neon branch with no way to tell them apart except reading
// application data (a restaurant literally named "(Dev)") — that's not a
// safety boundary, it's a label a real restaurant could coincidentally
// share. This marker is the actual boundary.
import { Client } from "pg";
import { parseDbIdentity } from "./db-identity.mjs";

export const ENVIRONMENT_MARKER_TABLE = "_rcs_database_environment";
export const KNOWN_ENVIRONMENTS = ["PRODUCTION", "DEVELOPMENT", "TEST"];

// Endpoint IDs known to be PRODUCTION, recorded here deliberately (not
// derived from database name, which Neon frequently reuses as "neondb" on
// every branch) — this is the same "don't rely on one signal" principle as
// the TEST gate's name-pattern check, applied to the DEV/PROD boundary.
// Update this list only when Production's Neon endpoint actually changes.
export const KNOWN_PRODUCTION_ENDPOINT_IDS = ["ep-tiny-base-b1rj6246"];

// Same idea, recorded for the other two environments — lets every guard
// assert "!= Development" / "!= Test" explicitly instead of only "== self",
// so a future copy-paste mistake that puts the same id in two lists is
// caught by the cross-check in assertProductionDatabaseIsSafe /
// assertDevelopmentDatabaseIsSafe rather than silently passing.
export const KNOWN_DEVELOPMENT_ENDPOINT_IDS = ["ep-solitary-leaf-b1q2002q"];
export const KNOWN_TEST_ENDPOINT_IDS = ["ep-steep-math-b1mu6kyv"];

/** Neon hostnames encode the endpoint id as the first label, with pooled
 * hosts appending "-pooler" — this strips that suffix so pooled and direct
 * hosts for the same endpoint compare equal. */
export function extractNeonEndpointId(host) {
  const firstLabel = host.split(".")[0] ?? "";
  return firstLabel.replace(/-pooler$/, "");
}

function endpointIdOf(connectionString) {
  const { host } = parseDbIdentity(connectionString);
  return extractNeonEndpointId(host);
}

export function isKnownProductionEndpoint(connectionString) {
  return KNOWN_PRODUCTION_ENDPOINT_IDS.includes(endpointIdOf(connectionString));
}
export function isKnownDevelopmentEndpoint(connectionString) {
  return KNOWN_DEVELOPMENT_ENDPOINT_IDS.includes(endpointIdOf(connectionString));
}
export function isKnownTestEndpoint(connectionString) {
  return KNOWN_TEST_ENDPOINT_IDS.includes(endpointIdOf(connectionString));
}

/** Reads the marker table live — returns null if unmarked/unreachable. */
export async function readDatabaseEnvironment(connectionString) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const res = await client.query(
      `SELECT environment FROM ${ENVIRONMENT_MARKER_TABLE} WHERE id = true`
    );
    return res.rows[0]?.environment ?? null;
  } catch {
    return null; // table doesn't exist yet, or connection failed — treated as "unmarked"
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Multi-signal guard for DEVELOPMENT-ONLY mutation scripts (e.g. dev data
 * cleanup). A single signal is never trusted alone — the August 2026
 * TEST/DEV incident and the later discovery that Development and
 * Production shared a Neon branch both came from relying on exactly one
 * weak signal (an env var name, a restaurant name). All of the following
 * must independently agree the target is DEVELOPMENT, or this throws:
 *
 *   1. NODE_ENV is not "production"
 *   2. the connection string was explicitly provided (never falls back to
 *      a default/guessed value)
 *   3. the endpoint is NOT a KNOWN_PRODUCTION_ENDPOINT_IDS entry
 *   4. the live _rcs_database_environment marker table says DEVELOPMENT
 *   5. (optional) the endpoint matches an explicitly expected id, if the
 *      caller knows which Development branch it expects
 *   6. (optional) directConnectionString, if given, resolves to the SAME
 *      endpoint as connectionString — catches a mismatched DATABASE_URL/
 *      DIRECT_URL pair (e.g. one edited, the other forgotten) before a
 *      migration-style operation runs against a split target.
 *
 * Returns normally (void) when safe; throws with a clear reason otherwise.
 */
export async function assertDevelopmentDatabaseIsSafe(
  connectionString,
  { expectedEndpointId, directConnectionString } = {}
) {
  if (!connectionString) {
    throw new Error("No connection string provided — refusing to guess a target for a development-only script.");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("NODE_ENV=production — refusing to run a development-only script.");
  }
  if (isKnownProductionEndpoint(connectionString)) {
    throw new Error(
      "This connection string points at a KNOWN PRODUCTION endpoint (scripts/lib/db-environment.mjs) — " +
        "refusing to run a development-only mutation script against it."
    );
  }
  if (isKnownTestEndpoint(connectionString)) {
    throw new Error(
      "This connection string points at the KNOWN TEST endpoint — a development-only script must not run " +
        "against the disposable test database either (it would corrupt integration-test isolation)."
    );
  }
  const { host } = parseDbIdentity(connectionString);
  if (expectedEndpointId && extractNeonEndpointId(host) !== expectedEndpointId) {
    throw new Error(
      `Endpoint "${extractNeonEndpointId(host)}" does not match the expected Development endpoint ` +
        `"${expectedEndpointId}" — refusing to run.`
    );
  }
  if (directConnectionString && endpointIdOf(directConnectionString) !== extractNeonEndpointId(host)) {
    throw new Error(
      `DATABASE_URL endpoint "${extractNeonEndpointId(host)}" and DIRECT_URL endpoint ` +
        `"${endpointIdOf(directConnectionString)}" don't match — one of them was likely edited without the other.`
    );
  }
  const environment = await readDatabaseEnvironment(connectionString);
  if (environment !== "DEVELOPMENT") {
    throw new Error(
      `Database is not marked as DEVELOPMENT (currently: ${environment ?? "unmarked"}). ` +
        "Run `npm run db:mark-environment -- --environment=DEVELOPMENT --confirm-target=<db-name>` first " +
        "if this is genuinely a development database, or point at the correct one."
    );
  }
}

/**
 * Inverse of assertDevelopmentDatabaseIsSafe, for PRODUCTION migration/
 * maintenance scripts (e.g. db-premigration-check.mjs). Proposed guard
 * architecture — not currently wired into any script that runs against
 * Production; see docs/database-safety.md for adoption notes. Requires:
 *
 *   1. the endpoint IS a KNOWN_PRODUCTION_ENDPOINT_IDS entry
 *   2. the live _rcs_database_environment marker table says PRODUCTION
 *   3. the caller passes back the exact --confirm-target value it received
 *      (the actual typed-confirmation friction lives in the calling
 *      script, same pattern as db-premigration-check.mjs's --confirm-target)
 */
export async function assertProductionDatabaseIsSafe(connectionString, { confirmedByOperator } = {}) {
  if (!connectionString) {
    throw new Error("No connection string provided — refusing to guess a target for a production operation.");
  }
  if (!confirmedByOperator) {
    throw new Error("Operator confirmation required (e.g. --confirm-target=<db-name>) — refusing to proceed silently.");
  }
  if (!isKnownProductionEndpoint(connectionString)) {
    throw new Error(
      "This connection string does NOT point at a KNOWN PRODUCTION endpoint — refusing to run a " +
        "production maintenance operation against it. If this is a legitimate new Production endpoint, " +
        "update KNOWN_PRODUCTION_ENDPOINT_IDS in scripts/lib/db-environment.mjs first."
    );
  }
  if (isKnownDevelopmentEndpoint(connectionString) || isKnownTestEndpoint(connectionString)) {
    // Structurally unreachable if the endpoint lists stay disjoint — kept as
    // an explicit cross-check so a future copy-paste mistake between the
    // three lists aborts loudly instead of silently passing.
    throw new Error(
      "This endpoint is listed as BOTH a known Production endpoint and a known Development/Test endpoint — " +
        "the endpoint id lists in scripts/lib/db-environment.mjs have overlapped. ABORT and fix the lists."
    );
  }
  const environment = await readDatabaseEnvironment(connectionString);
  if (environment !== "PRODUCTION") {
    throw new Error(
      `Database is not marked as PRODUCTION (currently: ${environment ?? "unmarked"}). ` +
        "Run `npm run db:mark-environment -- --environment=PRODUCTION --confirm-target=<db-name>` first, " +
        "with full awareness that this IS the production database."
    );
  }
}

/** Writes/overwrites the marker — callers must already have decided this is
 * safe (see scripts/mark-database-environment.mjs for the guarded CLI). */
export async function writeDatabaseEnvironment(connectionString, environment) {
  if (!KNOWN_ENVIRONMENTS.includes(environment)) {
    throw new Error(`Unknown environment "${environment}" — must be one of ${KNOWN_ENVIRONMENTS.join(", ")}`);
  }
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${ENVIRONMENT_MARKER_TABLE} (
        id BOOLEAN PRIMARY KEY DEFAULT true,
        environment TEXT NOT NULL CHECK (environment IN ('PRODUCTION', 'DEVELOPMENT', 'TEST')),
        labeled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ${ENVIRONMENT_MARKER_TABLE}_singleton CHECK (id)
      )
    `);
    await client.query(
      `INSERT INTO ${ENVIRONMENT_MARKER_TABLE} (id, environment, labeled_at) VALUES (true, $1, now())
       ON CONFLICT (id) DO UPDATE SET environment = EXCLUDED.environment, labeled_at = now()`,
      [environment]
    );
  } finally {
    await client.end().catch(() => {});
  }
}
