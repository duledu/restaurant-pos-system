#!/usr/bin/env node
/**
 * Verifies an existing backup file WITHOUT restoring it anywhere. A backup
 * is not considered valid just because pg_dump exited 0 — this checks:
 *   1. the file exists and is non-empty
 *   2. pg_restore can list its contents (the dump isn't truncated/corrupt)
 *   3. every business-critical table (+ any future Inventory table,
 *      derived live from schema.prisma) appears in that table of contents
 *
 * Run: npm run db:backup:verify                 (verifies the newest backup)
 *      npm run db:backup:verify -- <filename>    (verifies a specific one)
 */
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { repoRoot } from "./lib/env-loader.mjs";
import { listBackupContents } from "./lib/backup-verify-core.mjs";
import { getAllTables, getCriticalTables, getInventoryTables } from "./lib/schema-tables.mjs";

const backupsDir = join(repoRoot, "backups");

function findLatestBackup() {
  if (!existsSync(backupsDir)) return null;
  const files = readdirSync(backupsDir).filter((f) => f.endsWith(".dump"));
  if (files.length === 0) return null;
  files.sort(); // timestamped filenames sort chronologically
  return files[files.length - 1];
}

function main() {
  const arg = process.argv[2];
  const filename = arg || findLatestBackup();
  if (!filename) {
    throw new Error(`No backup file specified and none found in backups/. Run "npm run db:backup" first.`);
  }
  const filePath = join(backupsDir, filename);
  console.log(`Verifying: backups/${filename}`);

  const toc = listBackupContents(filePath);
  const dumped = new Set(toc.tables);

  const critical = getCriticalTables();
  const inventory = getInventoryTables();
  const all = getAllTables();

  const missingCritical = critical.filter((t) => !dumped.has(t.table));
  const missingInventory = inventory.filter((t) => !dumped.has(t.table));

  console.log(`\nTables found in dump: ${toc.tables.length} (schema currently declares ${all.length})`);
  console.log(`\nCritical tables (${critical.length}):`);
  for (const t of critical) {
    console.log(`  ${dumped.has(t.table) ? "OK  " : "MISSING"} ${t.table}  (${t.model})`);
  }

  if (inventory.length > 0) {
    console.log(`\nInventory tables detected in schema (${inventory.length}) — auto-included, no script changes needed:`);
    for (const t of inventory) {
      console.log(`  ${dumped.has(t.table) ? "OK  " : "MISSING"} ${t.table}  (${t.model})`);
    }
  }

  if (missingCritical.length > 0 || missingInventory.length > 0) {
    throw new Error(
      `Backup is INVALID: missing table(s): ` +
        [...missingCritical, ...missingInventory].map((t) => t.table).join(", ")
    );
  }

  console.log(`\nVERIFIED: backups/${filename} contains all ${critical.length} critical tables` +
    (inventory.length ? ` and all ${inventory.length} inventory table(s)` : "") + ".");
}

try {
  main();
} catch (err) {
  console.error("VERIFY FAILED:", err.message);
  process.exit(1);
}
