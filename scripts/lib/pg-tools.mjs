// Detects whether the PostgreSQL client tools (pg_dump/pg_restore) this
// backup system depends on are actually installed and runnable. Backups
// must FAIL LOUDLY and explain what to install, never silently no-op or
// fall back to a hand-rolled dump — pg_dump is what correctly handles
// sequences, constraints, and large objects; reimplementing that badly
// would be worse than refusing to run.
import { spawnSync } from "child_process";

/** @returns {{ok: true, version: string} | {ok: false, reason: string}} */
export function checkTool(bin) {
  let res;
  try {
    res = spawnSync(bin, ["--version"], { encoding: "utf8" });
  } catch (e) {
    return { ok: false, reason: `"${bin}" is not on PATH (${e.message}).` };
  }
  if (res.error) {
    return { ok: false, reason: `"${bin}" is not on PATH (${res.error.message}).` };
  }
  if (res.status !== 0) {
    return { ok: false, reason: `"${bin} --version" exited with code ${res.status}.` };
  }
  return { ok: true, version: res.stdout.trim() };
}

export function requireTool(bin, installHint) {
  const check = checkTool(bin);
  if (!check.ok) {
    throw new Error(
      `${check.reason}\n\n` +
        `TableCore's backup/restore tooling requires the PostgreSQL client tools ` +
        `(same major version as the Neon server, currently Postgres 16) to be ` +
        `installed and on PATH.\n${installHint}\n\n` +
        `This is a known environment limitation in some sandboxes — see ` +
        `docs/database-backup-recovery.md → "Environment limitation."`
    );
  }
  return check.version;
}

export const INSTALL_HINT =
  "  Windows: install \"PostgreSQL 16\" from https://www.postgresql.org/download/windows/ " +
  "(client tools only is enough) and add its \\bin directory to PATH, or " +
  "`choco install postgresql16 --params '/Password:unused'`.\n" +
  "  macOS:   brew install postgresql@16\n" +
  "  Linux:   apt-get install postgresql-client-16 (or your distro's equivalent)\n" +
  "  Docker:  docker run --rm -v <backups-dir>:/backups postgres:16 pg_dump ...";
