#!/usr/bin/env node
/**
 * Explicitly marks the database at DATABASE_URL (or DIRECT_URL as fallback)
 * as PRODUCTION, DEVELOPMENT, or TEST — writes the singleton
 * _rcs_database_environment marker table (see scripts/lib/db-environment.mjs).
 *
 * Deliberately manual and deliberately loud with friction, same philosophy
 * as db-premigration-check.mjs's --confirm-target: this writes exactly one
 * row, but marking a database wrong is exactly the kind of mistake that
 * causes real incidents, so it must never happen silently or automatically.
 *
 * Refuses to run unless:
 *   - --environment=PRODUCTION|DEVELOPMENT|TEST is given explicitly
 *   - --confirm-target=<database-name> matches the actual target
 *   - marking PRODUCTION requires the endpoint to be a KNOWN production
 *     endpoint (scripts/lib/db-environment.mjs); marking DEVELOPMENT/TEST
 *     requires the endpoint to NOT be a known production endpoint —
 *     this is a cross-check, not just trusting the operator's --environment
 *     flag at face value.
 *   - if the database is already marked as something ELSE, requires --force
 *     and prints exactly what is being overwritten.
 *
 * Run: node scripts/mark-database-environment.mjs --environment=DEVELOPMENT --confirm-target=<db-name>
 */
import { loadEnv } from "./lib/env-loader.mjs";
import { parseDbIdentity, redactConnectionString } from "./lib/db-identity.mjs";
import {
  isKnownProductionEndpoint,
  readDatabaseEnvironment,
  writeDatabaseEnvironment,
  KNOWN_ENVIRONMENTS,
} from "./lib/db-environment.mjs";

loadEnv();

const args = process.argv.slice(2);
const environment = args.find((a) => a.startsWith("--environment="))?.split("=")[1];
const confirmTarget = args.find((a) => a.startsWith("--confirm-target="))?.split("=")[1];
const force = args.includes("--force");

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!connectionString) throw new Error("DATABASE_URL / DIRECT_URL not set.");

  if (!environment || !KNOWN_ENVIRONMENTS.includes(environment)) {
    throw new Error(
      `--environment=<${KNOWN_ENVIRONMENTS.join("|")}> is required.\n` +
        `Example: node scripts/mark-database-environment.mjs --environment=DEVELOPMENT --confirm-target=<db-name>`
    );
  }

  const identity = parseDbIdentity(connectionString);
  console.log(`Target: ${redactConnectionString(connectionString)}`);

  if (!confirmTarget) {
    throw new Error(
      `Refusing to proceed without explicit confirmation. Re-run with:\n` +
        `  --confirm-target=${identity.database}\n` +
        `(must match the actual target database name exactly — intentional friction)`
    );
  }
  if (confirmTarget !== identity.database) {
    throw new Error(`--confirm-target="${confirmTarget}" does not match actual target "${identity.database}". ABORT.`);
  }

  const knownProdEndpoint = isKnownProductionEndpoint(connectionString);
  if (environment === "PRODUCTION" && !knownProdEndpoint) {
    throw new Error(
      "Refusing to mark as PRODUCTION: this endpoint is not in KNOWN_PRODUCTION_ENDPOINT_IDS " +
        "(scripts/lib/db-environment.mjs). If this genuinely is a new Production endpoint, update that list first."
    );
  }
  if (environment !== "PRODUCTION" && knownProdEndpoint) {
    throw new Error(
      `Refusing to mark as ${environment}: this endpoint IS the known PRODUCTION endpoint. ` +
        "Marking it as anything else would defeat the entire point of this guard."
    );
  }

  const existing = await readDatabaseEnvironment(connectionString);
  if (existing && existing !== environment && !force) {
    throw new Error(
      `Database is already marked as "${existing}", not "${environment}". Re-run with --force to relabel ` +
        "(only do this if the environment genuinely changed, e.g. a fresh branch being repurposed)."
    );
  }

  await writeDatabaseEnvironment(connectionString, environment);
  console.log(
    existing
      ? `Relabeled "${identity.database}" from ${existing} to ${environment}.`
      : `Marked "${identity.database}" as ${environment}.`
  );
}

main().catch((err) => {
  console.error(`\nABORT: ${err.message}`);
  process.exit(1);
});
