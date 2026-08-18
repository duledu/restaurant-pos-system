#!/usr/bin/env node
/**
 * TableCore logical backup — wraps `pg_dump` in Postgres "custom" format
 * (-Fc): compressed, supports selective/parallel restore, and its table of
 * contents can be listed with `pg_restore --list` WITHOUT touching any
 * database (used by scripts/db-backup-verify.mjs).
 *
 * READ-ONLY against the source database — pg_dump never writes.
 * Backups are written OUTSIDE the database, to ./backups/ (git-ignored,
 * see docs/database-backup-recovery.md), with an immutable timestamped
 * filename that is never overwritten.
 *
 * Run: npm run db:backup
 *      npm run db:backup -- --source=DATABASE_URL   (default: DIRECT_URL)
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { loadEnv, repoRoot } from "./lib/env-loader.mjs";
import { redactConnectionString } from "./lib/db-identity.mjs";
import { requireTool, INSTALL_HINT } from "./lib/pg-tools.mjs";
import { getAllTables, getCriticalTables } from "./lib/schema-tables.mjs";
import { listBackupContents } from "./lib/backup-verify-core.mjs";

loadEnv();

const args = process.argv.slice(2);
const sourceVar = (args.find((a) => a.startsWith("--source="))?.split("=")[1]) || "DIRECT_URL";
const connectionString = process.env[sourceVar] || process.env.DATABASE_URL;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return { date, time, combined: `${date}-${time}` };
}

function main() {
  if (!connectionString) {
    throw new Error(`Neither ${sourceVar} nor DATABASE_URL is set. Nothing to back up.`);
  }
  requireTool("pg_dump", INSTALL_HINT);

  const backupsDir = join(repoRoot, "backups");
  mkdirSync(backupsDir, { recursive: true });

  const ts = timestamp();
  const filename = `tablecore-${ts.combined}.dump`;
  const filePath = join(backupsDir, filename);

  if (existsSync(filePath)) {
    // Timestamp granularity is 1 second; this should be unreachable in
    // practice, but backups are immutable by design — never overwrite.
    throw new Error(`Refusing to overwrite existing backup file: ${filename}`);
  }

  const sourceLabel = redactConnectionString(connectionString);
  console.log(`Backing up ${sourceLabel} -> backups/${filename}`);

  const result = spawnSync(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-privileges", "--file", filePath, connectionString],
    { encoding: "utf8" }
  );

  if (result.error) {
    throw new Error(`pg_dump failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    // stderr from pg_dump can legitimately contain the connection string if
    // it fails to parse it — strip anything that looks like one before
    // surfacing the error.
    const safeStderr = (result.stderr || "").replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted>");
    throw new Error(`pg_dump exited with code ${result.status}:\n${safeStderr}`);
  }

  if (!existsSync(filePath) || statSync(filePath).size === 0) {
    throw new Error("pg_dump reported success but produced no file, or an empty file.");
  }

  const sizeBytes = statSync(filePath).size;
  console.log(`pg_dump complete: ${(sizeBytes / 1024 / 1024).toFixed(2)} MiB`);

  // Immediate lightweight verification — table-of-contents listing only,
  // never a restore. Fail loudly if pg_restore can't even list it.
  const toc = listBackupContents(filePath);
  const allTables = getAllTables();
  const criticalTables = getCriticalTables();
  const dumpedTableNames = new Set(toc.tables);
  const missingCritical = criticalTables.filter((t) => !dumpedTableNames.has(t.table));
  const missingAny = allTables.filter((t) => !dumpedTableNames.has(t.table));

  if (missingCritical.length > 0) {
    throw new Error(
      `Backup produced a file, but these CRITICAL tables are missing from its table of contents: ` +
        missingCritical.map((t) => t.table).join(", ") +
        `. Refusing to treat this as a valid backup.`
    );
  }

  const meta = {
    filename,
    createdAt: new Date().toISOString(),
    source: sourceLabel,
    sizeBytes,
    pgDumpFormat: "custom",
    tableCount: toc.tables.length,
    criticalTablesPresent: criticalTables.length,
    schemaTableCount: allTables.length,
    missingNonCriticalTables: missingAny.map((t) => t.table),
    verified: true,
  };
  writeFileSync(join(backupsDir, `${filename}.meta.json`), JSON.stringify(meta, null, 2));

  console.log(`Verified: ${toc.tables.length} tables in dump, all ${criticalTables.length} critical tables present.`);
  if (missingAny.length > 0) {
    console.warn(
      `Note: ${missingAny.length} non-critical schema table(s) not found in dump (likely empty/never-created tables, pg_dump still includes their DDL): ${missingAny
        .map((t) => t.table)
        .join(", ")}`
    );
  }
  console.log(`Backup complete: backups/${filename}`);
}

try {
  main();
} catch (err) {
  console.error("BACKUP FAILED:", err.message);
  process.exit(1);
}
