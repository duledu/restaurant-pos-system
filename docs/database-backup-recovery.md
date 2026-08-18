# Database Backup & Disaster Recovery

TableCore's database holds the restaurant's menu, inventory (once that
module exists), orders, payments, receipts, shifts, employees, voids, audit
history, and reporting history. This document is the procedure for
recovering all of it if it's ever lost — written to be followed by someone
under pressure, months from now, who has not read this before.

> **Tooling existing ≠ being protected.** Run `npm run db:backup:readiness`
> before ever telling anyone TableCore is "backup-protected." It reports
> one of `NOT PROTECTED` / `PARTIALLY PROTECTED` / `PROTECTED` and refuses
> to say `PROTECTED` unless a real, fresh, verified backup exists **and**
> Neon PITR has been manually confirmed in the console (§1). As of this
> writing that command reports `NOT PROTECTED` — `pg_dump`/`pg_restore`
> aren't installed on this machine yet and no real backup has been taken.
> The scripts below are ready and tested; a real backup has not been made.

Related: [`docs/database-safety.md`](./database-safety.md) covers *preventing*
accidental data loss (the TEST_DATABASE_URL isolation architecture). This
document covers *recovering* when prevention wasn't enough — a different
Neon branch corrupted, a bad migration, a bug that deleted the wrong rows,
Neon itself being unavailable.

## Two independent layers, on purpose

1. **Neon PITR** (Point-in-Time Restore) — Neon's own continuous history,
   see below. Fast, but it's a Neon-side capability: if the Neon project
   itself is misconfigured, deleted, or the plan's retention window has
   already passed, PITR alone isn't enough.
2. **Logical `pg_dump` backups** — a second, independent copy of the data
   that exists *outside* Neon entirely (local disk / wherever you configure
   offsite storage — see "Automation" below). This is what this repo's
   tooling (`scripts/db-backup*.mjs`) produces.

Never rely on only one of these.

---

## 1. Neon PITR / backup capabilities — confirmed vs. unknown

**What's confirmed from this repo:** the database is Neon Postgres
(`*.neon.tech`, see `DATABASE_URL`/`DIRECT_URL` in `.env`) — Neon's
PostgreSQL-compatible serverless offering. That's it — the specific plan,
its PITR retention window, and whether any custom retention/backup add-on
is configured are **not discoverable from this repository or this
environment**. No Neon API key, project ID, or plan tier is present in the
codebase (correctly — those aren't application secrets and don't belong
here).

**Report as UNKNOWN, verify in the Neon Console:**

| Question | Where to check |
|---|---|
| Which Neon plan (Free / Launch / Scale / Business / Enterprise)? | Neon Console → Billing |
| PITR retention window for this project (Free: up to 24h; paid plans: configurable, up to 7-30 days depending on plan) | Neon Console → Project → Settings → **Backup & restore** (or "Point-in-time restore") |
| Is "Instant restore" / branch-based restore available on this plan? | Same page — Neon implements PITR via branching: you create a new branch "as of" a past timestamp/LSN, rather than a traditional restore-in-place |
| Does this project have scheduled logical backups configured (Neon's own backup export, separate from PITR)? | Neon Console → Project → **Backups** (if present on this plan) |
| What is the actual current retention in days, right now? | Same Settings page — this can be changed by anyone with console access, so don't trust old documentation; re-check before relying on it |
| Is this the production branch or a dev branch? | Neon Console → Branches — confirm which branch `DATABASE_URL` in the production environment variables actually points to |

**How Neon PITR restore works (general Neon mechanism, verify against your
plan in the console before an actual incident):**

1. In the Neon Console, go to the project → **Branches**.
2. Create a new branch with "Time" or "LSN" set to just before the bad
   event (Neon lets you pick a timestamp within the retention window).
3. This produces a **new, separate branch** — it does NOT touch the
   existing production branch. Get its connection string.
4. Point `db:restore-drill`'s isolated-verification tooling at that new
   branch's connection string (see §8 below) and verify the data before
   deciding anything further.
5. Only after verification: either (a) re-point `DATABASE_URL` at the new
   branch (requires redeploying with the new env var, and downtime
   planning), or (b) `pg_dump` the good data out of the new branch and
   `pg_restore` the specific missing rows back into production, or (c) some
   hybrid — this is exactly the "human decides after verifying" step in the
   restore drill below.

**Do not modify Neon project settings (retention window, plan, branches)
as part of routine work — that requires explicit approval, per this task's
constraints.**

### Recording that you checked (so the readiness report can see it)

`npm run db:backup:readiness` cannot check Neon PITR itself — it's a
console setting, not something visible from the repo. After you've
verified it manually using the table above, record it by creating
`backups/neon-pitr-status.json` (gitignored, since `/backups/` is ignored
wholesale — this is deliberately a local operational note, not something to
commit):

```json
{
  "status": "CONFIRMED",
  "retentionDays": 7,
  "checkedAt": "2026-08-19T12:00:00Z",
  "checkedBy": "you@example.com",
  "notes": "Launch plan, PITR window confirmed 7 days in Neon Console > Settings > Backup & restore"
}
```

Until this file exists with `"status": "CONFIRMED"`, `db:backup:readiness`
reports Neon PITR as `UNKNOWN` — which is correct, because it hasn't been
checked, not because it's necessarily bad.

---

## 2-3. Second independent backup layer — `pg_dump`, immutable filenames

`scripts/db-backup.mjs` runs `pg_dump --format=custom` (the "custom"
format: compressed, and its table of contents can be listed and
selectively restored without a full restore) against `DIRECT_URL`
(fallback `DATABASE_URL`).

- **Schema, data, constraints, sequences — everything.** `pg_dump` with no
  `--table`/`--exclude-table` filters backs up the entire database exactly
  as-is; there is no allow-list to keep in sync.
- **Timestamped, immutable filenames**: `tablecore-YYYY-MM-DD-HHMMSS.dump`.
  The script refuses to overwrite an existing file of the same name.
- **Stored outside the live database**: written to `./backups/` at the repo
  root, which is `.gitignore`d — **never committed to Git** — and is a
  location entirely separate from the Neon database itself.
- Every backup gets a `<file>.dump.meta.json` sidecar recording creation
  time, source (host:port/database — never credentials), size, and which
  tables were verified present. This is what `db:backup:status` reads.

```bash
npm run db:backup              # creates backups/tablecore-<timestamp>.dump
npm run db:backup:verify       # verifies the newest backup
npm run db:backup:verify -- tablecore-2026-08-19-001500.dump   # verifies a specific one
```

### Environment limitation (this sandbox)

`pg_dump`/`pg_restore` (the official PostgreSQL client tools) are **not
installed in this development sandbox** — confirmed by running
`npm run db:backup`, which fails cleanly with an actionable "not on PATH"
error and installation instructions, and touches no database. This mirrors
the pre-existing, already-documented "embedded Postgres can't start under
an Administrator token" limitation in `docs/database-safety.md`. The
scripts are correct and will work as designed the moment the client tools
are available — on a normal developer machine, in CI, or via
`docker run postgres:16 pg_dump ...`. Install instructions are printed by
the scripts themselves and repeated in §11 below.

### Windows / PowerShell quick start (your normal dev machine)

**Step 0 — check whether you already have the client tools.** Run these in
PowerShell first; do not install anything yet, just check:

```powershell
pg_dump --version
pg_restore --version
```

- **Both print a version** (e.g. `pg_dump (PostgreSQL) 16.x`) → skip to
  Step 1, you already have what you need.
- **Either says "not recognized as the name of a cmdlet..."** → the
  PostgreSQL client tools aren't installed or aren't on PATH. This tooling
  will not install anything for you automatically. Install manually, then
  re-run the two commands above to confirm:
  - Download "PostgreSQL 16" from
    https://www.postgresql.org/download/windows/ (the installer lets you
    select "Command Line Tools" only — you don't need the server) — or —
    `choco install postgresql16 --params '/Password:unused'` if you use
    Chocolatey.
  - Confirm the installer added its `bin` folder (typically
    `C:\Program Files\PostgreSQL\16\bin`) to your `PATH`; if not, add it
    yourself (System Properties → Environment Variables) and open a new
    PowerShell window.

**Step 1 — CREATE the first real backup:**

```powershell
npm run db:backup
```

This reads `DIRECT_URL` (falls back to `DATABASE_URL`) from `.env` and runs
`pg_dump` — purely a `SELECT`-level read against Neon, it cannot modify,
seed, migrate, truncate, delete, or reset anything. Output goes to
`backups\tablecore-<timestamp>.dump` plus a `.meta.json` sidecar.

**Step 2 — VERIFY it:**

```powershell
npm run db:backup:verify
```

Confirms the file is non-empty, `pg_restore --list` can parse it, and every
critical table is present in its table of contents — without restoring
anything anywhere.

**Step 3 — CHECK overall status / readiness:**

```powershell
npm run db:backup:status       # simple health check — exit 0 if the latest backup is fresh+verified
npm run db:backup:readiness    # the full honest report — see below
```

None of these three commands touch Neon PITR settings, and none of them
write to the source database — `pg_dump`/`pg_restore --list` are read-only
by nature.

---

## 4. Retention policy

**Recommended baseline** (implemented, dry-run by default, in
`scripts/db-backup-prune.mjs`):

| Tier | Keep |
|---|---|
| Daily | every backup from the last 14 days |
| Weekly | one (the newest) per ISO week, for the last 8 weeks |
| Monthly | one (the newest) per calendar month, for the last 12 months |
| Year-end | the newest backup of each calendar year, kept indefinitely |

```bash
npm run db:backup:prune              # REPORT ONLY — shows what would be kept/deleted, deletes nothing
npm run db:backup:prune -- --execute # actually deletes what the report above said it would
```

**This is intentionally dry-run only until reviewed against real backup
history** — the task that introduced this tooling explicitly said not to
implement destructive pruning yet. Do not add `--execute` to any automated
schedule until someone has run the dry-run report for a few weeks and
confirmed the tiers behave as expected.

---

## 5. Pre-deploy / pre-migration procedure

**Before every production migration:**

```bash
npm run db:premigration-check -- --confirm-target=<database-name>
```

This performs, in order, and **aborts (non-zero exit, prints ABORT) if any
step fails — with no bypass flag**:

1. Prints the target database identity and requires you to retype its name
   via `--confirm-target=` (typo-proofs "I thought this was dev" mistakes).
2. Takes a fresh backup (or reuses one less than 60 minutes old) and
   verifies it (file exists, non-empty, `pg_restore --list` succeeds, every
   critical table present).
3. Snapshots critical-table row counts to
   `backups/<timestamp>-premigration-counts.json`.

Only if all three succeed does it print the go-ahead:

```
npx prisma migrate deploy
npm run db:postmigration-check -- --since=backups/<timestamp>-premigration-counts.json
```

`db:postmigration-check` re-counts the same tables and prints a before/after
table, exiting non-zero (without deleting or fixing anything) if any
critical table's count **decreased** — a decrease can be legitimate (a
reviewed cleanup migration), so this never auto-decides; it makes the
comparison impossible to miss so a human reviews it before calling the
migration successful.

**If backup/recovery readiness cannot be confirmed: the migration must not
proceed.** There is no override flag by design.

---

## 6-7. Critical table verification & backup validation

Both `db-backup.mjs` (right after dumping) and `db-backup-verify.mjs` (for
any existing file, any time later) check, in this order:

1. The backup **file exists** and is **not empty**.
2. **`pg_restore --list <file>`** succeeds — this parses the dump's table of
   contents without connecting to, or restoring into, any database. A
   truncated or corrupt dump fails here immediately.
3. Every **business-critical table** appears in that table of contents:
   `Restaurant`, `Location`, `Employee`, `MenuCategory`, `MenuItem`,
   `Order`, `OrderItem`, `OrderItemStation`, `Payment`, `Receipt`, `Shift`,
   `OrderItemVoid`, `PrintJob`, `AuditLog`.

**This list is not hardcoded as a table-name array** — `scripts/lib/schema-tables.mjs`
reads `packages/db/prisma/schema.prisma` directly (every `model X { ... @@map("y") }`
block) and resolves the current table name for each of the 14 model names
above. `db-backup-verify.mjs` additionally scans for any model whose name
matches `/inventory|stock/i` and reports it as an auto-detected inventory
table — **when the Inventory module is built, its tables are covered
automatically, with no script changes required**, satisfying the
"never hardcode in a way that excludes new Prisma tables" requirement.

A backup is never considered valid on `pg_dump`'s exit code alone.

---

## 8. Restore drill

```
PRODUCTION / DEV DATABASE  (DATABASE_URL / DIRECT_URL — untouched, read-only source)
     |
     v   pg_dump (already have this) OR a Neon PITR branch
BACKUP FILE  or  NEON PITR BRANCH
     |
     v   scripts/db-restore-drill.mjs  (pg_restore --clean, ONE direction only)
ISOLATED RECOVERY DATABASE   <-- restore always lands HERE
     |
     v   automatic: row counts for all 14 critical tables, printed
     v   manual: spot-check application-critical data (see §9)
     |
     v
A HUMAN decides whether/how anything gets promoted back — this tooling
never writes to the source database, ever.
```

```bash
# target must be an isolated, disposable database — never DATABASE_URL/DIRECT_URL
RESTORE_DRILL_DATABASE_URL=postgresql://user:pass@host:5432/rcs_restore_drill \
  npm run db:restore-drill -- backups/tablecore-2026-08-19-001500.dump
```

`db-restore-drill.mjs` **refuses to run** unless the target:

- resolves to a *different* host+port+database than both `DATABASE_URL` and
  `DIRECT_URL` (same host/port/database comparison logic as
  `tests/setup/db-identity.ts`, mirrored in `scripts/lib/db-identity.mjs`), and
- has a database name containing "test", "drill", or "restore" as a
  separate word.

This is the same fail-closed philosophy as the `TEST_DATABASE_URL` gate in
`docs/database-safety.md` — a destructive operation (`pg_restore --clean`)
only runs against a database that unambiguously identifies itself as
disposable. **Never restore directly over production or dev as a first
step.** Suitable isolated targets: a fresh Neon PITR branch (§1), the
embedded TEST Postgres instance (port 55433) used by
`npm run test:integration`, or `docker/docker-compose.yml`'s `postgres-test`
service.

**Not executable end-to-end in this sandbox** — same `pg_dump`/`pg_restore`
availability limitation as §2-3, plus the pre-existing "embedded Postgres
can't start under this sandbox's Administrator token" limitation from
`docs/database-safety.md`. Run this drill for real periodically (recommend:
quarterly, and always before a major migration) on a machine/CI runner
where both tools are available.

---

## 9. Restore verification checklist

After any restore into the isolated recovery database, verify at minimum:

- [ ] `restaurants`, `locations` — expected restaurant(s) present, correct names
- [ ] `employees` — expected count, correct roles (spot-check a few)
- [ ] `menu_categories`, `menu_items` — expected count, spot-check a few prices/names
- [ ] `orders`, `order_items` — non-zero for the expected historical range
- [ ] `payments`, `receipts` — non-zero, and **financial totals reconcile**:
      run the equivalent of `reporting.getSalesSummary` (or
      `SELECT SUM(amount) FROM payments WHERE ...`) against the restored
      database for a known date range and compare against what the
      production reporting dashboard showed for that same range before the
      incident
- [ ] `shifts` — expected count, opened/closed correctly paired
- [ ] `order_item_voids` — present, counts match expectations
- [ ] `audit_logs` — historical audit trail present and readable

Once the Inventory module exists, add:

- [ ] current stock levels match the last known-good snapshot
- [ ] `InventoryMovement` (or equivalent) ledger is complete and ordered —
      **never regenerate inventory history by estimating/guessing** after a
      loss; if the ledger is gone, that's a real, reportable data-loss
      event, not something to paper over with fabricated numbers

---

## 10. Inventory module — safety preparation (forward-looking)

The Inventory module doesn't exist yet. When it's built, this backup system
already covers it with **no changes required**, because:

- `pg_dump` backs up every table in the database — a new `InventoryItem`/
  `InventoryMovement`/etc. table is included automatically the moment it
  exists.
- `scripts/lib/schema-tables.mjs`'s `getInventoryTables()` already matches
  any model named `/inventory|stock/i` and `db-backup-verify.mjs` already
  reports on it — this will start printing real rows the day those models
  land in `schema.prisma`, with zero script edits.

**When that module is designed**, apply the same principles already used
elsewhere in this schema (see `docs/database-safety.md` → "Cascade / hard-
delete audit"): movement history should be **append-only** (never
UPDATE/DELETE a past movement — post a correcting movement instead, the
same pattern `OrderEvent`/`AuditLog` already use), and current stock should
be either a materialized/derived value recomputable from the movement
ledger, or itself protected by the same RESTRICT-by-default FK philosophy.
**Never rebuild stock levels by guessing after a loss** — if the movement
ledger is intact, stock is always recoverable exactly; if it isn't, that's
the actual incident to report, not something to patch over with an
estimate.

---

## 11. Automation design (not yet wired to a live scheduler)

**Nightly logical backup + Neon PITR together:**

- Neon PITR runs continuously and automatically — no action needed beyond
  confirming the retention window (§1).
- Logical backups (`npm run db:backup`) need a scheduler. Options, in order
  of how well they fit this stack (Next.js on Vercel + Neon):

  1. **GitHub Actions scheduled workflow** (`schedule: cron`) — runs on
     GitHub's own runners, which already have (or can install)
     `postgresql-client`; upload the resulting `.dump` as a workflow
     artifact or push it to your own storage (e.g. an S3/Backblaze bucket
     you control — see §12 for security requirements). This is the
     recommended starting point: no new paid service, and the schedule
     lives in version control.
  2. **Vercel Cron Jobs** — Vercel supports scheduled invocation of an API
     route; that route would need `pg_dump` available in the serverless
     function's environment, which Vercel's default Node runtime does not
     provide out of the box (would need a custom approach, e.g. shelling
     out isn't available in serverless — this option needs more research
     before it's viable; GitHub Actions is simpler).
  3. **A small always-on machine/VM you control** (systemd timer / cron) —
     if one already exists for other reasons.

- **Not proposed**: a third-party paid backup-as-a-service product — the
  task explicitly said not to add one without approval, and GitHub Actions
  already covers the "run this nightly, store the result somewhere durable"
  need without a new vendor.

No workflow file has been added to `.github/workflows/` by this change —
wiring a live schedule against production is an infrastructure change that
needs explicit approval first, per this task's constraints. When approved,
the workflow is straightforward: install `postgresql-client-16`, checkout
the repo (for `scripts/db-backup.mjs` and its `lib/`), set `DIRECT_URL`
from a repository secret, run `npm run db:backup`, then upload/ship the
resulting file to wherever offsite storage is approved, then run
`npm run db:backup:status` as the job's final step so a scheduler failure
(non-zero exit) is visible as a failed CI run.

---

## 12. Security

- **No credentials in filenames or logs.** Every script here logs
  `host:port/database` (via `redactConnectionString()` in
  `scripts/lib/db-identity.mjs`), never the full connection string; the one
  place a raw connection string is used is as a `pg_dump`/`pg_restore`
  argument passed directly to the child process (never through a shell, so
  it's never logged or shell-interpolated), and `pg_dump` stderr is
  scrubbed of anything matching a `postgres(ql)?://` URL before being
  surfaced in an error message.
- **Never committed to Git** — `/backups/` is `.gitignore`d.
- **No public bucket** — if/when offsite storage is added (§11), it must be
  a private bucket/container with access restricted to the backup job's
  credentials only; this needs explicit approval before being provisioned.
- **Restricted access** — only whoever runs migrations/backups (or the CI
  job's scoped secret) should have the connection string capable of
  reading the full database; consider a read-only Postgres role dedicated
  to `pg_dump` if/when this moves to a scheduled job, rather than reusing
  the application's runtime credentials.
- **Encryption at rest** — local `backups/` inherits whatever disk
  encryption the machine already has; any offsite bucket added later must
  have server-side encryption enabled (standard on S3/Backblaze/GCS by
  default — verify, don't assume).
- **Secure transport** — Neon connections already require `sslmode=require`
  (see `.env.example`); any offsite upload must use TLS.
- **Least privilege** — the backup job only needs `SELECT`/dump privileges,
  never write access; the restore-drill job only needs write access to the
  isolated target, never to production.

---

## 13. Monitoring — detecting a silent backup failure

`npm run db:backup:status` is the detection mechanism, designed to be the
last step of whatever runs backups on a schedule (§11) so a scheduler
failure is visible as a failed job, not silence:

| Failure mode | Detected how | Exit code |
|---|---|---|
| Backup never configured / `backups/` doesn't exist | no directory found | 1 |
| Backup job ran but produced nothing | no `.meta.json` sidecars found | 1 |
| Backup file suspiciously small | `sizeBytes < 1024` in the sidecar | 1 |
| Backup verification failed | sidecar's `verified` field isn't `true` | 1 |
| Last successful backup is too old | `--max-age-hours` (default 26h, so one missed nightly run is caught but normal timing jitter isn't) | 1 |

`npm run db:backup:readiness` is the human-facing counterpart to
`db:backup:status` — same underlying data, but framed as the explicit
`NOT PROTECTED` / `PARTIALLY PROTECTED` / `PROTECTED` verdict this document
opens with, plus the Neon PITR acknowledgment check. Run it (not
`db:backup:status`) whenever the question is "can we actually recover right
now," rather than "did last night's scheduled job succeed."

No external alerting (Slack/email/PagerDuty webhook) has been wired up —
the task said not to add one without approval. What exists is the
building block: a script with a meaningful non-zero exit code, which any
of GitHub Actions' built-in failure notifications, a cron job piping to
`mail`, or a future approved alerting integration can consume directly.

---

## 14. Integrity + backup, together (P0 sentinel integration)

This slots directly into the existing pre/post-operation pattern from the
P0 investigation (`scripts/db-count-critical-tables.mjs`, `npm run db:counts`):

```
BEFORE  →  npm run db:premigration-check -- --confirm-target=<db>
             (critical row counts + verified backup + recovery point, all in one gate)
MIGRATION →  npx prisma migrate deploy
AFTER   →  npm run db:postmigration-check -- --since=<snapshot from BEFORE>
             (re-counts the same critical tables, flags any decrease)
```

Unexpected data loss at the AFTER step: **STOP.** Don't run further
migrations or deploys. Use the verified backup from the BEFORE step (or a
Neon PITR branch) with the restore drill (§8) to recover into an isolated
database, verify it (§9), and only then decide how to proceed — the same
"preserve evidence, verify read-only, don't guess" discipline as
`docs/database-safety.md`'s incident response.

---

## What NOT to do

- Do not run `db:restore-drill` against `DATABASE_URL`/`DIRECT_URL` — it is
  hard-blocked, but don't try to work around the block.
- Do not `pg_restore` directly into production as a first recovery step,
  ever — always land in an isolated database and verify first (§8-9).
- Do not run `db:backup:prune -- --execute` on a schedule until the dry-run
  report has been reviewed against real backup history.
- Do not add offsite storage or a scheduled workflow against production
  without approval (§11).
- Do not rebuild Inventory stock levels by estimation after a loss (§10) —
  recover from the movement ledger or report the loss honestly.
- Do not treat a successful `pg_dump` exit code alone as proof of a valid
  backup — always run (or trust the automatic) `db:backup:verify`.
- Do not modify Neon project settings (retention, plan, branch topology)
  without approval.

## Recovery checklist (print this, or keep it open, during an actual incident)

1. **Stop.** Don't run migrations, seeds, or "fix" scripts yet.
2. Identify the target database precisely (`npm run db:counts` — read-only).
3. Check `npm run db:backup:status` — is there a recent, verified backup?
4. Check Neon Console → Backup & restore — what's the PITR window, and does
   it cover the time just before the incident?
5. Pick a recovery point: latest good local backup, or a Neon PITR branch
   at a specific timestamp (§1).
6. Restore into an **isolated** database only (§8) — never production first.
7. Verify thoroughly (§9) — row counts, spot-checks, financial reconciliation.
8. Only after verification: decide, with a human in the loop, how (or
   whether) anything gets promoted back to production. This is a distinct,
   deliberate step — not an automatic continuation of the restore.
9. Document what happened, when, and why, the same way
   `docs/database-safety.md` documents the August 2026 incident — future
   you (or whoever's on call next time) needs this written down.
