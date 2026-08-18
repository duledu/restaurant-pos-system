// Shared "is this dump file structurally valid" logic used by both
// db-backup.mjs (immediately after creating a backup) and
// db-backup-verify.mjs (checking an arbitrary existing backup file later).
// Everything here is read-only against the FILE — `pg_restore --list` never
// connects to any database, it only parses the dump's table of contents.
import { spawnSync } from "child_process";
import { existsSync, statSync } from "fs";
import { requireTool, INSTALL_HINT } from "./pg-tools.mjs";

/**
 * @param {string} filePath
 * @returns {{ tables: string[], raw: string }}
 */
export function listBackupContents(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file does not exist: ${filePath}`);
  }
  const size = statSync(filePath).size;
  if (size === 0) {
    throw new Error(`Backup file is empty (0 bytes): ${filePath}`);
  }

  requireTool("pg_restore", INSTALL_HINT);
  const result = spawnSync("pg_restore", ["--list", filePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`pg_restore --list failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`pg_restore --list exited with code ${result.status}: ${result.stderr}`);
  }

  const raw = result.stdout;
  // TOC lines for table data look like:
  //   123; 0 456789 TABLE DATA public menu_items neondb_owner
  const tables = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/TABLE DATA\s+\S+\s+(\S+)\s+/);
    if (m) tables.push(m[1]);
  }
  return { tables, raw };
}
