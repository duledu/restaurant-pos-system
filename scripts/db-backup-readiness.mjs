#!/usr/bin/env node
/**
 * The honest answer to "are we actually backup-protected right now?" —
 * distinct from db-backup-status.mjs (which assumes a backup pipeline is
 * already running and just flags staleness). This script draws a hard line
 * between "the tooling exists" and "a real, verified, recent backup
 * exists" and refuses to report PROTECTED unless both a fresh verified
 * logical backup AND a confirmed Neon PITR check are in place. Read-only:
 * it inspects local files and runs `<tool> --version`, nothing else — it
 * never connects to any database itself.
 *
 * Run: npm run db:backup:readiness
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { repoRoot } from "./lib/env-loader.mjs";
import { checkTool } from "./lib/pg-tools.mjs";

const backupsDir = join(repoRoot, "backups");
const pitrAckPath = join(backupsDir, "neon-pitr-status.json");
const MAX_FRESH_AGE_HOURS = 26; // one missed nightly run is caught; normal timing jitter isn't

function findLatestBackup() {
  if (!existsSync(backupsDir)) return null;
  const metaFiles = readdirSync(backupsDir).filter((f) => f.endsWith(".dump.meta.json"));
  if (metaFiles.length === 0) return null;
  const parsed = metaFiles
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(backupsDir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return parsed[0];
}

function readPitrAck() {
  if (!existsSync(pitrAckPath)) return null;
  try {
    return JSON.parse(readFileSync(pitrAckPath, "utf8"));
  } catch {
    return null;
  }
}

function fmtBytes(n) {
  if (n == null) return "N/A";
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function fmtAge(hours) {
  if (hours == null) return "N/A";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

function main() {
  const pgDump = checkTool("pg_dump");
  const pgRestore = checkTool("pg_restore");
  const toolingReady = pgDump.ok && pgRestore.ok;

  const latest = findLatestBackup();
  const ageHours = latest ? (Date.now() - new Date(latest.createdAt).getTime()) / 3_600_000 : null;
  const isVerified = latest?.verified === true;
  const isFresh = ageHours != null && ageHours <= MAX_FRESH_AGE_HOURS;

  const pitrAck = readPitrAck();
  const pitrConfirmed = pitrAck?.status === "CONFIRMED";

  let overall;
  let overallReason;
  if (!toolingReady) {
    overall = "NOT PROTECTED";
    overallReason = "pg_dump/pg_restore are not installed — no backup can be created or verified from this machine.";
  } else if (!latest || !isVerified) {
    overall = "NOT PROTECTED";
    overallReason = "No verified backup exists yet. Backup tooling being present is not the same as a real backup existing.";
  } else if (!isFresh || !pitrConfirmed) {
    overall = "PARTIALLY PROTECTED";
    overallReason = !isFresh
      ? `Latest verified backup is ${fmtAge(ageHours)} old (stale beyond ${MAX_FRESH_AGE_HOURS}h) — refresh it before relying on it.`
      : "Logical backup is fresh and verified, but Neon PITR status has not been confirmed in the Neon Console (still UNKNOWN) — only one of the two independent layers is confirmed working.";
  } else {
    overall = "PROTECTED";
    overallReason = "A fresh, verified logical backup exists AND Neon PITR has been manually confirmed in the Neon Console.";
  }

  console.log("BACKUP STATUS:");
  console.log(`- Logical backup tooling: ${toolingReady ? "READY" : "NOT READY"}`);
  console.log(`- pg_dump available: ${pgDump.ok ? "YES" : "NO"}${pgDump.ok ? ` (${pgDump.version})` : ` — ${pgDump.reason}`}`);
  console.log(`- pg_restore available: ${pgRestore.ok ? "YES" : "NO"}${pgRestore.ok ? ` (${pgRestore.version})` : ` — ${pgRestore.reason}`}`);
  console.log(`- Last successful backup: ${latest ? latest.createdAt : "NONE"}`);
  console.log(`- Last verified backup: ${isVerified ? latest.createdAt : "NONE"}`);
  console.log(`- Backup age: ${fmtAge(ageHours)}`);
  console.log(`- Backup size: ${latest ? fmtBytes(latest.sizeBytes) : "N/A"}`);
  console.log(`- Neon PITR status: ${pitrConfirmed ? `CONFIRMED (checked ${pitrAck.checkedAt || "date not recorded"}, retention ${pitrAck.retentionDays ?? "?"}d)` : "UNKNOWN — not verifiable from this repo, must be checked manually in the Neon Console (see docs/database-backup-recovery.md)"}`);
  console.log(`- Overall recovery readiness: ${overall}`);
  console.log(`  (${overallReason})`);

  if (overall !== "PROTECTED") {
    console.log(
      `\nDo NOT report TableCore as backup-protected until this says PROTECTED. ` +
        `See docs/database-backup-recovery.md for exactly what's missing.`
    );
  }

  process.exit(overall === "PROTECTED" ? 0 : 1);
}

main();
