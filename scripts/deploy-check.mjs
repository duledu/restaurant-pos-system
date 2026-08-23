#!/usr/bin/env node
/**
 * CHECK-ONLY pre-deploy readiness gate.
 *
 * Runs the full local validation suite (typecheck, lint, unit tests, schema
 * validation, build) and reports the current DATABASE_URL target's
 * environment identity — so "am I about to deploy code that depends on a
 * schema this database doesn't have?" and "which database am I even
 * pointed at right now?" both get answered in one place, before you push.
 *
 * This is deliberately NOT a Production-migration gate — that's
 * db-premigration-check.mjs, which already enforces PRODUCTION identity via
 * assertProductionDatabaseIsSafe(). deploy-check.mjs runs happily against
 * whatever DATABASE_URL currently resolves to (Development, most days) and
 * just reports what it finds; it does not require PRODUCTION and does not
 * refuse to run against Development.
 *
 * It NEVER applies migrations, runs `db push`, resets anything, or writes
 * to any database. Every step here is read-only or purely local (compiling,
 * linting, running the existing test suite, building the Next.js app).
 *
 * On failure: fixes the actual problem. This script does not, and must
 * never, "fix" a failure by skipping the check or weakening a guard.
 *
 * Run: npm run deploy:check
 */
import { execFileSync } from "child_process";
import { repoRoot } from "./lib/env-loader.mjs";
import { loadEnv } from "./lib/env-loader.mjs";
import { parseDbIdentity, redactConnectionString } from "./lib/db-identity.mjs";
import { readDatabaseEnvironment } from "./lib/db-environment.mjs";

loadEnv();

function step(label, fn) {
  console.log(`\n=== ${label} ===`);
  fn();
  console.log(`✓ ${label} passed`);
}

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" });
}

async function main() {
  step("typecheck", () => run("npm", ["run", "typecheck"]));
  step("lint", () => run("npm", ["run", "lint"]));
  step("unit tests", () => run("npm", ["run", "test:unit"]));
  step("prisma schema validation", () =>
    run("npx", ["prisma", "validate", "--schema", "packages/db/prisma/schema.prisma"])
  );
  step("build", () => run("npm", ["run", "build"]));

  console.log(`\n=== database target identity (informational — read-only) ===`);
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("DATABASE_URL not set — skipping (nothing to report).");
  } else {
    const identity = parseDbIdentity(connectionString);
    console.log(`Target: ${redactConnectionString(connectionString)}`);
    const environment = await readDatabaseEnvironment(connectionString);
    console.log(`Environment marker: ${environment ?? "UNMARKED"}`);
    if (!environment) {
      console.log(
        `⚠ This database has no _rcs_database_environment marker. Run \`npm run db:mark-environment\` ` +
          `if this is a database that should have one (Production/Development/Test).`
      );
    }
  }

  console.log(`\n=== READY ===`);
  console.log(`Local validation passed. This does NOT mean Production is ready to receive new code.`);
  console.log(`Before deploying against a schema change, separately confirm (see docs/database-safety.md):`);
  console.log(`  1. npm run db:migrate:status        (against the real Production DATABASE_URL)`);
  console.log(`  2. npm run db:premigration-check -- --confirm-target=<db-name>   (if a migration is pending)`);
  console.log(`  3. npm run db:migrate:deploy         (applies it — Production only, explicit)`);
  console.log(`  4. npm run db:postmigration-check -- --since=<snapshot>`);
  console.log(`  5. only then deploy the application code that depends on the new schema`);
}

main().catch((err) => {
  console.error(`\nABORT: ${err.message}`);
  process.exit(1);
});
