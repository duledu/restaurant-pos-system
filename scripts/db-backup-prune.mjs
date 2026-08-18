#!/usr/bin/env node
/**
 * Retention pruning for local backup files ONLY — never touches any
 * database. Implements the recommended baseline retention policy (see
 * docs/database-backup-recovery.md → Retention policy):
 *   - keep every backup from the last 14 days
 *   - keep one per week for the last 8 weeks
 *   - keep one per month for the last 12 months
 *   - keep the year-end backup indefinitely
 *
 * DRY RUN BY DEFAULT. This intentionally never deletes anything unless you
 * pass --execute — retention behavior must be reviewed against real backup
 * history before it's allowed to delete files (see task requirements).
 *
 * Run: npm run db:backup:prune              (report only, deletes nothing)
 *      npm run db:backup:prune -- --execute (actually deletes what the
 *                                             report above said it would)
 */
import { readdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { repoRoot } from "./lib/env-loader.mjs";

const backupsDir = join(repoRoot, "backups");
const execute = process.argv.includes("--execute");

const DAY_MS = 86_400_000;
const RETENTION = {
  dailyDays: 14,
  weeklyWeeks: 8,
  monthlyMonths: 12,
};

function parseBackupDate(filename) {
  // tablecore-YYYY-MM-DD-HHMMSS.dump
  const m = filename.match(/^tablecore-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.dump$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function main() {
  if (!existsSync(backupsDir)) {
    console.log("No backups/ directory — nothing to prune.");
    return;
  }
  const files = readdirSync(backupsDir).filter((f) => f.endsWith(".dump"));
  const dated = files
    .map((f) => ({ file: f, date: parseBackupDate(f) }))
    .filter((x) => x.date !== null)
    .sort((a, b) => b.date - a.date); // newest first

  if (dated.length === 0) {
    console.log("No backups found.");
    return;
  }

  const now = Date.now();
  const keep = new Set();
  const reason = new Map();

  // Rule 1: keep everything within the daily window.
  for (const b of dated) {
    if (now - b.date.getTime() <= RETENTION.dailyDays * DAY_MS) {
      keep.add(b.file);
      reason.set(b.file, `within last ${RETENTION.dailyDays} days (daily)`);
    }
  }

  // Rule 2: one per ISO week for the weekly window (the newest backup in each week).
  const weekOf = (d) => {
    const t = new Date(d);
    const day = (t.getDay() + 6) % 7; // Mon=0
    t.setDate(t.getDate() - day);
    return t.toISOString().slice(0, 10);
  };
  const weekSeen = new Set();
  for (const b of dated) {
    if (now - b.date.getTime() > RETENTION.weeklyWeeks * 7 * DAY_MS) continue;
    const key = weekOf(b.date);
    if (!weekSeen.has(key)) {
      weekSeen.add(key);
      keep.add(b.file);
      if (!reason.has(b.file)) reason.set(b.file, `newest backup of its week (weekly, last ${RETENTION.weeklyWeeks}w)`);
    }
  }

  // Rule 3: one per calendar month for the monthly window (the newest backup in each month).
  const monthSeen = new Set();
  for (const b of dated) {
    if (now - b.date.getTime() > RETENTION.monthlyMonths * 31 * DAY_MS) continue;
    const key = `${b.date.getFullYear()}-${b.date.getMonth()}`;
    if (!monthSeen.has(key)) {
      monthSeen.add(key);
      keep.add(b.file);
      if (!reason.has(b.file)) reason.set(b.file, `newest backup of its month (monthly, last ${RETENTION.monthlyMonths}mo)`);
    }
  }

  // Rule 4: keep the newest backup of each calendar year indefinitely (year-end).
  const yearSeen = new Set();
  for (const b of dated) {
    const key = String(b.date.getFullYear());
    if (!yearSeen.has(key)) {
      yearSeen.add(key);
      keep.add(b.file);
      if (!reason.has(b.file)) reason.set(b.file, "newest backup of its year (year-end, kept indefinitely)");
    }
  }

  const toDelete = dated.filter((b) => !keep.has(b.file));

  console.log(`${dated.length} backup(s) on disk. Retention would keep ${keep.size}, delete ${toDelete.length}.\n`);
  console.log("KEEP:");
  for (const b of dated.filter((x) => keep.has(x.file))) {
    console.log(`  ${b.file}  — ${reason.get(b.file)}`);
  }
  console.log(`\n${execute ? "DELETING" : "WOULD DELETE (dry run — pass --execute to actually delete)"}:`);
  for (const b of toDelete) {
    console.log(`  ${b.file}`);
    if (execute) {
      unlinkSync(join(backupsDir, b.file));
      const metaPath = join(backupsDir, `${b.file}.meta.json`);
      if (existsSync(metaPath)) unlinkSync(metaPath);
    }
  }
  if (toDelete.length === 0) console.log("  (nothing to delete)");

  if (!execute && toDelete.length > 0) {
    console.log(`\nDry run only — no files were deleted. Re-run with --execute to apply.`);
  }
}

main();
