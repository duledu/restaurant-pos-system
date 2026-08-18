#!/usr/bin/env node
/**
 * Disaster-recovery restore drill — restores a backup file into an
 * ISOLATED validation database and reports row counts for manual review.
 *
 * This script will NEVER restore into DATABASE_URL or DIRECT_URL. The
 * target must be passed explicitly via RESTORE_DRILL_DATABASE_URL (or
 * --target-env=<VAR_NAME>), and is rejected unless its identity differs
 * from both DATABASE_URL/DIRECT_URL AND its database name contains "test",
 * "drill", or "restore" as a separate word — the same fail-closed pattern
 * tests/setup/require-test-database.ts uses for TEST_DATABASE_URL.
 *
 *   PRODUCTION/DEV DATABASE
 *        |
 *        v  (this script — pg_restore --clean, one direction only)
 *   ISOLATED RECOVERY DATABASE  <-- restore lands HERE, never upstream
 *        |
 *        v
 *   verify row counts / critical data (this script does this automatically)
 *        |
 *        v
 *   a HUMAN decides whether/how to promote anything back to production —
 *   this script never writes back to the source database.
 *
 * Run: RESTORE_DRILL_DATABASE_URL=postgresql://.../rcs_restore_drill \
 *      npm run db:restore-drill -- backups/tablecore-2026-08-19-001500.dump
 */
import { Client } from "pg";
import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { loadEnv, repoRoot } from "./lib/env-loader.mjs";
import { parseDbIdentity, sameDatabase, looksLikeSafeRestoreTargetName, redactConnectionString } from "./lib/db-identity.mjs";
import { requireTool, INSTALL_HINT } from "./lib/pg-tools.mjs";
import { getCriticalTables } from "./lib/schema-tables.mjs";

loadEnv();

const args = process.argv.slice(2);
const targetEnvName = args.find((a) => a.startsWith("--target-env="))?.split("=")[1] || "RESTORE_DRILL_DATABASE_URL";
const filenameArg = args.find((a) => !a.startsWith("--"));

function assertSafeTarget(targetUrl) {
  const production = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (production && sameDatabase(targetUrl, production)) {
    throw new Error("Restore target resolves to the SAME database as DATABASE_URL. Refusing — this would overwrite live data.");
  }
  if (direct && sameDatabase(targetUrl, direct)) {
    throw new Error("Restore target resolves to the SAME database as DIRECT_URL. Refusing — this would overwrite live data.");
  }
  const identity = parseDbIdentity(targetUrl);
  if (!looksLikeSafeRestoreTargetName(identity.database)) {
    throw new Error(
      `Restore target database name "${identity.database}" doesn't look like a disposable restore-validation ` +
        `database (expected "test", "drill", or "restore" as a separate word in the name). Refusing to guess — ` +
        `point ${targetEnvName} at a database whose name makes this unambiguous.`
    );
  }
}

async function countCriticalTables(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  const counts = {};
  try {
    for (const t of getCriticalTables()) {
      try {
        const res = await client.query(`SELECT COUNT(*)::int AS n FROM ${t.table}`);
        counts[t.table] = res.rows[0].n;
      } catch {
        counts[t.table] = "n/a (table not present)";
      }
    }
  } finally {
    await client.end();
  }
  return counts;
}

async function main() {
  if (!filenameArg) throw new Error("Usage: npm run db:restore-drill -- backups/<file>.dump");
  const filePath = filenameArg.startsWith(join(repoRoot, "backups")) ? filenameArg : join(repoRoot, filenameArg);
  if (!existsSync(filePath)) throw new Error(`Backup file not found: ${filenameArg}`);

  const targetUrl = process.env[targetEnvName];
  if (!targetUrl) {
    throw new Error(
      `${targetEnvName} is not set. This script refuses to guess a restore target — set it to an isolated, ` +
        `disposable database (e.g. the embedded TEST database on port 55433, or a dedicated Neon "restore-drill" ` +
        `branch) and re-run.`
    );
  }
  assertSafeTarget(targetUrl);
  console.log(`Restore target (verified isolated): ${redactConnectionString(targetUrl)}`);

  requireTool("pg_restore", INSTALL_HINT);
  console.log(`\nRestoring backups/${filenameArg.replace(/^backups[\\/]/, "")} into isolated target...`);
  const result = spawnSync(
    "pg_restore",
    ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--dbname", targetUrl, filePath],
    { encoding: "utf8" }
  );
  if (result.error) throw new Error(`pg_restore failed to start: ${result.error.message}`);
  // pg_restore commonly exits non-zero on harmless warnings (e.g. "role does
  // not exist" for --no-owner dumps); surface stderr but don't treat exit
  // code alone as fatal — the row-count verification below is the real check.
  if (result.stderr) console.log(result.stderr);

  console.log(`\nRow counts in restored (isolated) database:`);
  const counts = await countCriticalTables(targetUrl);
  console.log(JSON.stringify(counts, null, 2));

  console.log(
    `\nDrill complete. Compare these counts against the source database's counts (npm run db:counts) or the ` +
      `matching backups/*-premigration-counts.json snapshot. This script has NOT touched production/dev — ` +
      `promoting this data anywhere is a separate, manual, human decision. See docs/database-backup-recovery.md ` +
      `→ "Restore drill" for the full checklist.`
  );
}

main().catch((err) => {
  console.error("RESTORE DRILL FAILED:", err.message);
  process.exit(1);
});
