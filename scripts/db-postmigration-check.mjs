#!/usr/bin/env node
/**
 * Post-migration integrity check. Re-counts the same critical tables
 * snapshotted by db-premigration-check.mjs and compares — any UNEXPECTED
 * decrease in a critical table is reported loudly (not silently). Some
 * decreases can be legitimate (e.g. a deliberate cleanup migration you
 * already reviewed) — this script does not auto-decide, it makes the
 * before/after impossible to miss so a human decides.
 *
 * Run: npm run db:postmigration-check -- --since=backups/<ts>-premigration-counts.json
 */
import { Client } from "pg";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { loadEnv, repoRoot } from "./lib/env-loader.mjs";
import { getCriticalTables } from "./lib/schema-tables.mjs";

loadEnv();

const args = process.argv.slice(2);
let sincePath = args.find((a) => a.startsWith("--since="))?.split("=")[1];

function findLatestSnapshot() {
  const backupsDir = join(repoRoot, "backups");
  if (!existsSync(backupsDir)) return null;
  const files = readdirSync(backupsDir).filter((f) => f.endsWith("-premigration-counts.json"));
  if (files.length === 0) return null;
  files.sort();
  return join(backupsDir, files[files.length - 1]);
}

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

async function main() {
  if (!sincePath) {
    const latest = findLatestSnapshot();
    if (!latest) throw new Error("No --since=<path> given and no premigration snapshot found in backups/.");
    sincePath = latest;
  }
  const before = JSON.parse(readFileSync(sincePath, "utf8"));

  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DIRECT_URL / DATABASE_URL not set.");

  const after = await countCriticalTables(connectionString);

  console.log(`Comparing against snapshot taken ${before.takenAt} (${before.database})\n`);
  console.log("table".padEnd(24) + "before".padStart(10) + "after".padStart(10) + "  change");
  let regressions = 0;
  for (const table of Object.keys(before.counts)) {
    const b = before.counts[table];
    const a = after[table] ?? 0;
    const delta = a - b;
    const flag = delta < 0 ? "  <-- DECREASED" : "";
    if (delta < 0) regressions++;
    console.log(table.padEnd(24) + String(b).padStart(10) + String(a).padStart(10) + `  ${delta >= 0 ? "+" : ""}${delta}${flag}`);
  }

  if (regressions > 0) {
    throw new Error(
      `${regressions} critical table(s) DECREASED after migration. This is not necessarily wrong (a reviewed ` +
        `cleanup migration can legitimately reduce a count) but it must be explicitly reviewed before you ` +
        `consider this migration successful. Do not proceed to further deploys until reviewed.`
    );
  }
  console.log("\nOK: no critical table decreased.");
}

main().catch((err) => {
  console.error("POST-MIGRATION CHECK:", err.message);
  process.exit(1);
});
