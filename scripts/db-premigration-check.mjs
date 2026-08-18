#!/usr/bin/env node
/**
 * Pre-migration safety gate. Run this BEFORE `npm run db:migrate:deploy`
 * against any non-disposable database. It:
 *   1. prints the target database identity and requires you to explicitly
 *      confirm it (typo-proofs "I thought I was on dev" mistakes)
 *   2. takes a fresh backup (or verifies a very recent one exists) and
 *      verifies it
 *   3. snapshots critical-table row counts to backups/<ts>-premigration-counts.json
 *
 * If any step fails, this exits non-zero and prints ABORT — the migration
 * must not proceed. There is no bypass flag; if backup/recovery readiness
 * cannot be confirmed, do not migrate.
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
  console.log(`=== STEP 1: confirm target ===`);
  console.log(`Migration target: ${redactConnectionString(connectionString)}`);
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

  console.log(`\n=== STEP 2: backup / recovery point ===`);
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

  console.log(`\n=== STEP 3: pre-migration integrity snapshot ===`);
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
