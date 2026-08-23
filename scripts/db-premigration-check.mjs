#!/usr/bin/env node
/**
 * Pre-migration safety gate. Run this BEFORE `npm run db:migrate:deploy`
 * against any non-disposable database. It:
 *   0. verifies database environment identity (assertProductionDatabaseIsSafe:
 *      known Production endpoint + live _rcs_database_environment marker
 *      says PRODUCTION + not the known Development/Test endpoint)
 *   1. prints the target database identity and requires you to explicitly
 *      confirm it (typo-proofs "I thought I was on dev" mistakes)
 *   2. inspects migration status (read-only `prisma migrate status`) —
 *      fails loudly if it can't be determined cleanly
 *   3. takes a fresh backup (or verifies a very recent one exists) and
 *      verifies it
 *   4. snapshots critical-table row counts to backups/<ts>-premigration-counts.json
 *
 * If any step fails, this exits non-zero and prints ABORT — the migration
 * must not proceed. There is no bypass flag; if identity, migration status,
 * or backup/recovery readiness cannot be confirmed, do not migrate.
 *
 * This script is specifically for the PRODUCTION target — that's what
 * assertProductionDatabaseIsSafe enforces. It will correctly refuse to run
 * against Development or Test (use db:migrate:deploy directly there; those
 * environments don't need this gate's friction).
 *
 * Run: npm run db:premigration-check -- --confirm-target=<db-name>
 */
import { Client } from "pg";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { loadEnv, repoRoot } from "./lib/env-loader.mjs";
import { parseDbIdentity, redactConnectionString } from "./lib/db-identity.mjs";
import { getCriticalTables } from "./lib/schema-tables.mjs";
import { assertProductionDatabaseIsSafe } from "./lib/db-environment.mjs";

loadEnv();

const args = process.argv.slice(2);
const confirmTarget = args.find((a) => a.startsWith("--confirm-target="))?.split("=")[1];
const maxBackupAgeMinutes = Number(args.find((a) => a.startsWith("--max-backup-age-minutes="))?.split("=")[1] ?? 60);
const backupsDir = join(repoRoot, "backups");

async function countCriticalTables(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  const counts = {};
  try {
    for (const t of getCriticalTables()) {
      const res = await client.query(`SELECT COUNT(*)::int AS n FROM ${t.table}`);
      counts[t.table] = res.rows[0].n;
    }
  } finally {
    await client.end();
  }
  return counts;
}

function latestBackupMeta() {
  if (!existsSync(backupsDir)) return null;
  const metaFiles = readdirSync(backupsDir).filter((f) => f.endsWith(".dump.meta.json"));
  if (metaFiles.length === 0) return null;
  const parsed = metaFiles.map((f) => JSON.parse(readFileSync(join(backupsDir, f), "utf8")));
  parsed.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return parsed[0];
}

async function main() {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DIRECT_URL / DATABASE_URL not set.");

  const identity = parseDbIdentity(connectionString);

  console.log(`=== STEP 0: database environment identity ===`);
  console.log(`Target: ${redactConnectionString(connectionString)}`);
  // Throws (and aborts the whole run) unless the endpoint is the KNOWN
  // Production endpoint AND the live marker table agrees — see
  // scripts/lib/db-environment.mjs. This is the check that would have
  // caught "Development and Production share a Neon branch" immediately,
  // and now prevents this specific gate from ever running against anything
  // but the confirmed Production database.
  await assertProductionDatabaseIsSafe(connectionString, { confirmedByOperator: Boolean(confirmTarget) });
  console.log(`Confirmed: known PRODUCTION endpoint, marker reads PRODUCTION.`);

  console.log(`\n=== STEP 1: confirm target ===`);
  if (!confirmTarget) {
    throw new Error(
      `Refusing to proceed without explicit confirmation. Re-run with:\n` +
        `  npm run db:premigration-check -- --confirm-target=${identity.database}\n` +
        `(the database name must match exactly — this is intentional friction, not a bug)`
    );
  }
  if (confirmTarget !== identity.database) {
    throw new Error(
      `--confirm-target="${confirmTarget}" does not match the actual target database "${identity.database}". ` +
        `ABORT — you may be pointed at the wrong environment.`
    );
  }
  console.log(`Confirmed: proceeding against "${identity.database}".`);

  console.log(`\n=== STEP 2: migration status (read-only) ===`);
  let migrateStatusOutput;
  try {
    migrateStatusOutput = execFileSync(
      "npx",
      ["prisma", "migrate", "status", "--schema", join(repoRoot, "packages", "db", "prisma", "schema.prisma")],
      { cwd: repoRoot, encoding: "utf8", env: process.env, shell: process.platform === "win32" }
    );
  } catch (err) {
    migrateStatusOutput = (err.stdout ?? "") + (err.stderr ?? "");
  }
  console.log(migrateStatusOutput);
  // "Pending" is the NORMAL reason to run this gate (you're about to apply
  // one) — only a genuinely FAILED migration or completely unreadable
  // output aborts here. Applying/deciding what to do about pending
  // migrations is a separate, explicit step after this gate passes.
  if (/failed migration/i.test(migrateStatusOutput)) {
    throw new Error("A migration has FAILED on the target database. Do not proceed — investigate manually first.");
  }
  if (!/up to date|have not yet been applied/i.test(migrateStatusOutput)) {
    throw new Error("Could not determine migration status cleanly from the output above. ABORT.");
  }

  console.log(`\n=== STEP 3: backup / recovery point ===`);
  let meta = latestBackupMeta();
  const ageMinutes = meta ? (Date.now() - new Date(meta.createdAt).getTime()) / 60_000 : Infinity;
  if (!meta || ageMinutes > maxBackupAgeMinutes) {
    console.log(
      meta
        ? `Newest backup is ${ageMinutes.toFixed(1)}min old (max allowed ${maxBackupAgeMinutes}min) — taking a fresh one.`
        : `No backup found — taking one now.`
    );
    execFileSync(process.execPath, [join(repoRoot, "scripts", "db-backup.mjs")], { stdio: "inherit" });
    meta = latestBackupMeta();
  } else {
    console.log(`Using existing backup (${ageMinutes.toFixed(1)}min old): ${meta.filename}`);
  }
  if (!meta || meta.verified !== true) {
    throw new Error("No verified backup available. ABORT.");
  }
  console.log(`Recovery point confirmed: backups/${meta.filename} (${meta.createdAt}).`);

  console.log(`\n=== STEP 4: pre-migration integrity snapshot ===`);
  const counts = await countCriticalTables(connectionString);
  console.log(JSON.stringify(counts, null, 2));

  mkdirSync(backupsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = join(backupsDir, `${ts}-premigration-counts.json`);
  writeFileSync(
    snapshotPath,
    JSON.stringify({ takenAt: new Date().toISOString(), database: identity.database, backupFile: meta.filename, counts }, null, 2)
  );
  console.log(`Snapshot saved: ${snapshotPath.replace(repoRoot, "").replace(/^[\\/]/, "")}`);

  console.log(`\n=== READY ===`);
  console.log(`Backup verified and integrity snapshot saved. Safe to run:`);
  console.log(`  npx prisma migrate deploy`);
  console.log(`Then run: npm run db:postmigration-check -- --since=${snapshotPath}`);
}

main().catch((err) => {
  console.error(`\nABORT — migration must NOT proceed: ${err.message}`);
  process.exit(1);
});
