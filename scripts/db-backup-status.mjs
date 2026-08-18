#!/usr/bin/env node
/**
 * Backup monitoring check — "did the last backup actually happen and was
 * it good?" Designed to be run on a schedule (see docs/database-backup-
 * recovery.md → Automation) and to fail with a non-zero exit code (the
 * universal signal any scheduler/CI/monitoring system already understands)
 * when something is wrong — a failed backup must never fail silently.
 *
 * Exit codes: 0 = healthy, 1 = missing/stale/unverified/failed.
 *
 * Run: npm run db:backup:status
 *      npm run db:backup:status -- --max-age-hours=26
 */
import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { repoRoot } from "./lib/env-loader.mjs";

const backupsDir = join(repoRoot, "backups");
const args = process.argv.slice(2);
const maxAgeHours = Number(args.find((a) => a.startsWith("--max-age-hours="))?.split("=")[1] ?? 26);

function main() {
  if (!existsSync(backupsDir)) {
    throw new Error(`No backups/ directory found — no backup has ever been taken. Run "npm run db:backup".`);
  }
  const metaFiles = readdirSync(backupsDir).filter((f) => f.endsWith(".dump.meta.json"));
  if (metaFiles.length === 0) {
    throw new Error(`backups/ exists but contains no completed backups. Run "npm run db:backup".`);
  }

  const backups = metaFiles
    .map((f) => {
      try {
        return { file: f, ...JSON.parse(readFileSync(join(backupsDir, f), "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const latest = backups[0];
  const ageHours = (Date.now() - new Date(latest.createdAt).getTime()) / 3_600_000;

  console.log(`Latest backup: ${latest.filename}`);
  console.log(`  created:    ${latest.createdAt} (${ageHours.toFixed(1)}h ago)`);
  console.log(`  size:       ${(latest.sizeBytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`  source:     ${latest.source}`);
  console.log(`  tables:     ${latest.tableCount} (${latest.criticalTablesPresent} critical, all present)`);
  console.log(`  verified:   ${latest.verified === true ? "yes" : "NO"}`);
  console.log(`\nTotal backups on disk: ${backups.length}`);

  const problems = [];
  if (latest.verified !== true) problems.push("latest backup was not verified");
  if (latest.sizeBytes < 1024) problems.push(`latest backup is suspiciously small (${latest.sizeBytes} bytes)`);
  if (ageHours > maxAgeHours) problems.push(`latest backup is ${ageHours.toFixed(1)}h old (max allowed: ${maxAgeHours}h)`);

  if (problems.length > 0) {
    throw new Error(`UNHEALTHY:\n  - ${problems.join("\n  - ")}`);
  }
  console.log("\nSTATUS: healthy.");
}

try {
  main();
} catch (err) {
  console.error("BACKUP STATUS CHECK FAILED:", err.message);
  process.exit(1);
}
