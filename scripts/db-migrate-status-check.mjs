#!/usr/bin/env node
/**
 * CHECK-ONLY pre-deploy migration safeguard.
 *
 * Root cause this exists for: application code was deployed while the
 * database it queried was missing a migration (`20260823120000_menu_modifiers`)
 * that had never been applied — nothing in the pipeline ever asked "does the
 * target database actually have every migration this code expects?" before
 * the deploy went out.
 *
 * This script answers exactly that question and NOTHING else:
 *   - runs `prisma migrate status` (Prisma's own read-only comparison of
 *     the migrations/ folder against the target database's
 *     _prisma_migrations table)
 *   - exits 0 only when every migration in the repo is applied and none
 *     failed
 *   - exits 1 (failing the build/CI step that calls this) when anything is
 *     pending, failed, or unreadable
 *
 * It NEVER applies, resets, or repairs anything:
 *   - no `prisma migrate deploy`
 *   - no `prisma migrate dev`
 *   - no `prisma db push`
 *   - no `--accept-data-loss` / `--force-reset`
 *   - no writes of any kind to the target database
 *
 * Intended use: run this as a required step BEFORE `next build` in CI/Vercel
 * (against whatever DATABASE_URL that environment already has configured —
 * e.g. Vercel's Production env var when run in a Production build). If it
 * fails, the fix is to run the existing `npm run db:migrate:deploy` (with
 * `npm run db:premigration-check` first, per docs/database-safety.md)
 * against that same target BEFORE re-running the build — never to make this
 * check pass by weakening it.
 *
 * This script only CHECKS. Wiring it into the actual Vercel build command
 * is a separate, explicit decision — not made by adding this file.
 *
 * Run: npm run db:migrate:status   (or: node scripts/db-migrate-status-check.mjs)
 */
import { execFileSync } from "child_process";
import { join } from "path";
import { loadEnv, repoRoot } from "./lib/env-loader.mjs";
import { redactConnectionString } from "./lib/db-identity.mjs";

loadEnv();

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("ABORT — DATABASE_URL / DIRECT_URL not set. Cannot check migration status.");
  process.exit(1);
}

console.log(`Target database: ${redactConnectionString(connectionString)}`);
console.log(`Checking migration status (read-only — prisma migrate status)...\n`);

const schemaPath = join(repoRoot, "packages", "db", "prisma", "schema.prisma");

let output = "";
let exitCode = 0;
try {
  output = execFileSync("npx", ["prisma", "migrate", "status", "--schema", schemaPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32",
  });
} catch (err) {
  // prisma migrate status exits non-zero when the database is behind/ahead
  // of the migrations folder — this is expected signal, not a script bug.
  output = (err.stdout ?? "") + (err.stderr ?? "");
  exitCode = 1;
}

console.log(output);

const hasPending = /have not yet been applied/i.test(output);
const hasFailed = /failed migration/i.test(output);
const isUpToDate = /Database schema is up to date/i.test(output);

if (hasFailed) {
  console.error("\nABORT — one or more migrations FAILED on the target database. Do not deploy. Investigate manually.");
  process.exit(1);
}
if (hasPending) {
  console.error(
    "\nABORT — target database is missing one or more migrations that exist in this repository.\n" +
      "Application code that depends on the pending migration(s) must NOT be deployed yet.\n" +
      "Fix: run `npm run db:premigration-check` then `npm run db:migrate:deploy` against this exact target, then re-run this check."
  );
  process.exit(1);
}
if (!isUpToDate && exitCode !== 0) {
  console.error("\nABORT — could not confirm migration status cleanly (unexpected prisma output above). Treat as unsafe to deploy.");
  process.exit(1);
}

console.log("\nOK — all migrations in the repository are applied to the target database. Safe to deploy dependent application code.");
process.exit(0);
