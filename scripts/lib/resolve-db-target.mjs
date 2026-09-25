// Single, explicit entry point for resolving which database an admin/
// maintenance CLI script targets.
//
// WHY THIS EXISTS (2026-09-14 incident): `npx tsx
// packages/db/prisma/sync-permissions.ts` was intended to run against
// PREPROD but silently connected to PRODUCTION instead. Root cause: root
// `.env` holds the Production DATABASE_URL/DIRECT_URL, `.env.local` holds
// Development/PREPROD (a Next.js-only override convention), and
// `@prisma/client`'s own internal env loading only ever reads `.env` — it
// has no concept of `.env.local` at all. A bare `new PrismaClient()` in a
// stand-alone script therefore always resolved to Production, regardless
// of what a separately-run verification script (which explicitly loaded
// `.env.local` first) had appeared to confirm moments earlier. Two
// processes reading "the environment" through different precedence rules
// is the actual defect — not a one-off mistake in a single script.
//
// The fix: every admin/maintenance script that can WRITE must call
// resolveDatabaseTarget() and construct its PrismaClient from the URL it
// returns (`new PrismaClient({ datasources: { db: { url } } })`) — NEVER
// `new PrismaClient()` with no datasource override, which falls back to
// ambient process.env / @prisma/client's own .env search. There is no
// default environment: a script MUST be invoked with an explicit
// `--env=test|preprod|production` flag, and each named environment maps to
// exactly one file, read in isolation (never merged with, or shadowed by,
// any other env file or ambient process.env value). The safety decision
// itself is never based on the filename or the flag alone — the resolved
// connection is always cross-checked against the live, authoritative
// `_rcs_database_environment` marker table before anything is returned.
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  isKnownProductionEndpoint,
  isKnownDevelopmentEndpoint,
  isKnownTestEndpoint,
  extractNeonEndpointId,
  readDatabaseEnvironment,
  KNOWN_DEVELOPMENT_ENDPOINT_IDS,
  KNOWN_PRODUCTION_ENDPOINT_IDS,
  KNOWN_TEST_ENDPOINT_IDS,
} from "./db-environment.mjs";
import { parseDbIdentity, redactConnectionString } from "./db-identity.mjs";

const REAL_REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Explicit, unambiguous file per named environment — no precedence, no
// fallback, no "whichever loaded first wins".
export const ENV_FILES = {
  test: ".env.test",
  preprod: ".env.local",
  production: ".env",
};

// requestedEnvironment (CLI vocabulary) <-> the _rcs_database_environment
// marker's own enum values (DEVELOPMENT/PRODUCTION/TEST — that table
// predates the "preprod" name). "PREPROD" is only ever a display label.
const EXPECTED_MARKER = { test: "TEST", preprod: "DEVELOPMENT", production: "PRODUCTION" };
const MARKER_DISPLAY = { DEVELOPMENT: "PREPROD", PRODUCTION: "PRODUCTION", TEST: "TEST" };
const KNOWN_ENDPOINT_CHECK = { test: isKnownTestEndpoint, preprod: isKnownDevelopmentEndpoint, production: isKnownProductionEndpoint };
const KNOWN_ENDPOINT_IDS = { test: KNOWN_TEST_ENDPOINT_IDS, preprod: KNOWN_DEVELOPMENT_ENDPOINT_IDS, production: KNOWN_PRODUCTION_ENDPOINT_IDS };

export class DatabaseTargetError extends Error {}

function violation(requestedEnvironment, actualLabel) {
  return new DatabaseTargetError(
    ["DATABASE SAFETY VIOLATION", `Requested: ${requestedEnvironment.toUpperCase()}`, `Actual: ${actualLabel}`, "WRITE BLOCKED"].join(
      "\n"
    )
  );
}

function parseArgs(argv) {
  const envArg = argv.find((a) => a.startsWith("--env="));
  const environment = envArg ? envArg.slice("--env=".length) : null;
  const confirmProduction = argv.includes("--confirm-production");
  return { environment, confirmProduction };
}

/**
 * Resolves and validates the database target for an admin/maintenance
 * script. Throws DatabaseTargetError — never guesses, never silently falls
 * back — if the target is missing, ambiguous, or fails any safety check.
 * Prints the resolved environment and a masked (never raw) endpoint before
 * returning, so the target is always visible in script output prior to any
 * write the caller goes on to perform.
 *
 * @param {object} [options]
 * @param {string[]} [options.argv] - defaults to process.argv.slice(2)
 * @param {string} [options.repoRoot] - defaults to the real repo root; only
 *   ever overridden by tests, to point at fixture env files.
 * @param {(connectionString: string) => Promise<string|null>} [options.readEnvironmentMarker]
 *   - injectable for tests; defaults to the real live-DB marker read.
 */
export async function resolveDatabaseTarget({
  argv = process.argv.slice(2),
  repoRoot = REAL_REPO_ROOT,
  readEnvironmentMarker = readDatabaseEnvironment,
} = {}) {
  const { environment, confirmProduction } = parseArgs(argv);

  if (!environment) {
    throw new DatabaseTargetError(
      "No --env flag supplied. Refusing to guess a database target — pass exactly one of: " +
        `${Object.keys(ENV_FILES).join(", ")} (e.g. --env=preprod).`
    );
  }
  if (!(environment in ENV_FILES)) {
    throw new DatabaseTargetError(
      `Unknown --env=${environment}. Must be one of: ${Object.keys(ENV_FILES).join(", ")}.`
    );
  }
  if (environment === "production" && !confirmProduction) {
    throw new DatabaseTargetError(
      "--env=production requires --confirm-production as well — refusing to target Production without an " +
        "explicit, separate confirmation flag on the command line. No implicit Production writes."
    );
  }

  const envFile = ENV_FILES[environment];
  const envFilePath = path.join(repoRoot, envFile);
  // Isolated parse (processEnv: {}) — never touches the real process.env, so
  // no ambient value (a shell profile, a previously run script, CI
  // injection, a decoy file sitting next to this one) can shadow or be
  // shadowed by what THIS specific, explicitly-named file actually
  // contains. This is the direct fix for the .env/.env.local ambiguity.
  const { parsed, error } = loadDotenv({ path: envFilePath, processEnv: {} });
  if (error || !parsed) {
    throw new DatabaseTargetError(
      `Could not read ${envFile} at "${repoRoot}": ${error?.message ?? "file not found"}. ` +
        (environment === "test"
          ? "Integration tests use their own disposable local Postgres cluster (scripts/lib/local-test-db.mjs); " +
            "a real .env.test pointed at the known Test Neon branch must be created before --env=test can be used here."
          : "")
    );
  }
  // Production credentials live under PRODUCTION_DATABASE_URL/
  // PRODUCTION_DIRECT_URL inside .env — NEVER the plain DATABASE_URL/
  // DIRECT_URL, which stay reserved for the developer's ordinary local
  // session (PREPROD, via .env.local reads that never touch this branch).
  // This is now the ONLY place in the codebase that reads the PRODUCTION_*
  // keys, so every caller (db-studio.mjs, db-premigration-check.mjs, the
  // migrate-deploy wrapper, etc.) gets a correctly-resolved Production
  // target for free, with no risk of silently falling back to whatever
  // .env's plain vars happen to hold that day.
  //
  // Their names are also historically inverted from their actual roles
  // (independently verified against Neon by connecting through both):
  // PRODUCTION_DATABASE_URL is the DIRECT/non-pooler connection string,
  // PRODUCTION_DIRECT_URL is the POOLED one. Corrected here, once — no
  // caller needs to know about this.
  let databaseUrl, directUrl;
  if (environment === "production") {
    const rawDatabaseUrl = parsed.PRODUCTION_DATABASE_URL; // actually direct/non-pooler
    const rawDirectUrl = parsed.PRODUCTION_DIRECT_URL; // actually pooled
    if (!rawDatabaseUrl || !rawDirectUrl) {
      throw new DatabaseTargetError(`${envFile} is missing PRODUCTION_DATABASE_URL and/or PRODUCTION_DIRECT_URL.`);
    }
    databaseUrl = rawDirectUrl; // pooled -> DATABASE_URL (runtime/query convention)
    directUrl = rawDatabaseUrl; // direct -> DIRECT_URL (migration convention)
  } else {
    databaseUrl = parsed.DATABASE_URL;
    directUrl = parsed.DIRECT_URL;
    if (!databaseUrl || !directUrl) {
      throw new DatabaseTargetError(`${envFile} is missing DATABASE_URL and/or DIRECT_URL.`);
    }
  }

  const dbEndpoint = extractNeonEndpointId(parseDbIdentity(databaseUrl).host);
  const directEndpoint = extractNeonEndpointId(parseDbIdentity(directUrl).host);
  if (dbEndpoint !== directEndpoint) {
    throw new DatabaseTargetError(
      `${envFile}: DATABASE_URL endpoint "${dbEndpoint}" and DIRECT_URL endpoint "${directEndpoint}" ` +
        "don't match — one was likely edited without the other."
    );
  }

  // Static, pre-network cross-check: does the resolved endpoint even belong
  // to the requested environment's known-id list? This alone would have
  // caught the 2026-09-14 incident (preprod resolving to the known
  // Production endpoint) without ever opening a connection.
  if (isKnownProductionEndpoint(databaseUrl) && environment !== "production") {
    throw violation(environment, "PRODUCTION (known endpoint — connection not attempted)");
  }
  if (isKnownDevelopmentEndpoint(databaseUrl) && environment !== "preprod") {
    throw violation(environment, "PREPROD (known endpoint — connection not attempted)");
  }
  if (isKnownTestEndpoint(databaseUrl) && environment !== "test") {
    throw violation(environment, "TEST (known endpoint — connection not attempted)");
  }
  if (!KNOWN_ENDPOINT_CHECK[environment](databaseUrl)) {
    throw new DatabaseTargetError(
      `--env=${environment} resolved (via ${envFile}) to endpoint "${dbEndpoint}", which is not a known ` +
        `${environment} endpoint (${KNOWN_ENDPOINT_IDS[environment].join(", ") || "(none configured)"}). Refusing to proceed.`
    );
  }

  // Authoritative check: the live marker on the ACTUAL connection, not the
  // filename or the flag. This is what makes the guard correct even if
  // `.env`/`.env.local` themselves were wrong, stale, or swapped.
  const marker = await readEnvironmentMarker(databaseUrl);
  const expectedMarker = EXPECTED_MARKER[environment];
  if (marker !== expectedMarker) {
    throw violation(environment, marker ? (MARKER_DISPLAY[marker] ?? marker) : "UNMARKED");
  }

  const masked = redactConnectionString(databaseUrl);
  console.log(`[db-target] env=${environment} file=${envFile} endpoint=${masked} marker=${marker}`);

  return { environment, databaseUrl, directUrl, endpointId: dbEndpoint, envFile };
}

/**
 * Builds a child-process environment object with DATABASE_URL/DIRECT_URL
 * set to the resolved target, for spawning Prisma CLI, pg_dump, or any
 * other child process that expects those conventional variable names.
 * NEVER mutates the caller's own process.env, and never writes to any
 * .env/.env.local file — the substitution exists only for the spawned
 * child. Same pattern already proven by db-studio.mjs's local
 * buildStudioSpawnEnv; shared here so every other Production-capable
 * script (premigration check, migrate-deploy, backup, postmigration
 * check) uses the identical mechanism instead of five reimplementations.
 */
export function buildChildEnv(target, baseEnv = process.env) {
  return { ...baseEnv, DATABASE_URL: target.databaseUrl, DIRECT_URL: target.directUrl };
}
