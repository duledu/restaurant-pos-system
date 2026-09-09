# TEST PostgreSQL storage investigation — 2026-09-09

**Result: root cause not fully explained, but a strong, repeatable, evidence-backed fix was found and validated.** The default TEST PostgreSQL volume (`C:\...\.local-postgres-data-test`) reliably reproduced the `IO / DataFileImmediateSync` stall (4/4 combined-run attempts). The exact same workload against a second local fixed volume (`H:`) passed cleanly 3/3 times, including one fully green 69/69 combined run via the real validation tooling. `scripts/lib/local-test-db.mjs` now supports an opt-in `RCS_TEST_PG_DATA_DIR` override so any developer whose machine shows this pattern can point the local TEST cluster at a more reliable volume — the default path is unchanged for everyone else.

## A. Current TEST PostgreSQL storage layout

- Data directory: `C:\Users\PC\restaurant-pos-system\.local-postgres-data-test` (repo-relative, git-ignored).
- No separate tablespace: `pg_wal` is a real subdirectory (not a symlink/junction) of the data directory — WAL lives on the same volume as the rest of the cluster.
- PostgreSQL: `16.14` (embedded, via the `embedded-postgres` npm package), started with no explicit `-c` flags — `fsync`, `full_page_writes`, `synchronous_commit` are all Postgres 16 defaults (`on`), confirmed live via `SHOW`, never explicitly set anywhere in this repo.
- `checkpoint_timeout = 5min`; no timed or requested checkpoints occurred during any of the observed stall windows.
- Database size at time of investigation: ~19.5 MB, 46 public tables.
- Reset statement under investigation: `TRUNCATE tenants, permissions, login_throttles CASCADE` (fixed, centralized in `tests/setup/reset-test-db.ts`, called from ~52 integration test files).

## B. Windows filesystem/volume findings

- Full path resolves to a plain NTFS directory; `Get-Item -Force` shows only the `Directory` attribute at every level from `C:\` down to the data directory — no `ReparsePoint` anywhere in the chain, i.e. **not** a OneDrive-redirected folder, symlink, or junction.
- Not compressed (`compact /Q` reports new files will not be compressed), not flagged encrypted.
- `C:` — NTFS, Fixed, ~255 GB total, ~77 GB free (~30% free) — not a low-disk-space condition.
- Physical disk backing `C:`: Disk 0, **SPCC Solid State Disk**, SATA bus, Healthy. Not removable, not a network path, not virtualized/mounted.
- Windows Defender: real-time protection and behavior monitoring are **on** (not disabled, not touched). Exactly one exclusion path is configured; a filtered, non-elevated query found it does **not** match this repo's path, but a direct, unfiltered enumeration of exclusion values requires administrator rights not available in this session — so the exclusion's exact value is **unknown**, not confirmed either way. No claim is made that Defender is or is not a factor.
- A point-in-time snapshot (taken after, not during, a stall) showed `Avg. Disk sec/Write ≈ 0.29ms` and `Current Disk Queue Length = 0` — consistent with the earlier finding that the stall is intermittent, not a sustained condition.

## C. DataFileImmediateSync reproduction measurements

A new diagnostic tool, `apps/print-agent/Profile-TestStorage.mjs`, runs N controlled, isolated cycles of the exact production statement (fresh dedicated connection → small fixture insert → `TRUNCATE tenants, permissions, login_throttles CASCADE`, timed) with a fail-closed safety net (its own cancel→terminate→confirm sequence, reusing the same technique as the real harness, so a stall during profiling is still safely contained — never left running).

**40 isolated cycles on the default (`C:`) volume:**

| min | median | p95 | max |
| --- | --- | --- | --- |
| 551ms | 575ms | 651ms | 660ms |

**40 isolated cycles on the alternate (`H:`) volume:**

| min | median | p95 | max |
| --- | --- | --- | --- |
| 434ms | 450ms | 503ms | 524ms |

Neither isolated run reproduced a multi-second stall. This itself is informative: back-to-back `TRUNCATE` cycles alone, with no other concurrent load, do not reproduce the anomaly on either volume — it has only ever been observed during the full "combined" 69-test selection (7 files, ~50-75s, multiple concurrent Vitest fork-pool worker processes), never during the standalone 22-test or 47-test groups run alone.

## D. PostgreSQL wait-event evidence

Four real stalls were captured this session (via the existing 200ms `pg_stat_activity` sampler in `apps/print-agent/Test-TableCore.mjs`) while running the exact `combined` selection, at four different points in the file sequence (`print-reprint`, `print-cancellation`→`print-routing` boundary twice, `print-cancellation`→`print-routing` again). One is traced second-by-second in full:

- Backend enters `TRUNCATE tenants, permissions, login_throttles CASCADE` and is observed continuously active from ~1.1s to ~13.1s elapsed (the full deadline), **every single 200ms sample in that window** shows `wait_event_type=IO`, `wait_event=DataFileImmediateSync`, `blockers=[]`.
- No other wait event type was ever observed for the stalled backend.
- `pg_blocking_pids()` was empty throughout — nothing else was holding a lock on it.
- `pg_stat_bgwriter` counters (`checkpoints_timed`, `checkpoints_req`) did not increase during any stall window — ruling out a checkpoint storm as the cause, consistent with the prior turn's finding.
- All four stalls were correctly detected and safely contained by the fail-closed harness (`stopped: true` in the poison marker each time); independent monitoring (`maxConcurrentResets`) confirmed **zero** overlapping destructive resets in all four cases.

## E. OS/storage correlation found

- **Volume correlates strongly**: the identical `combined` workload (same code, same Postgres settings, same schema) failed 4/4 on `C:` and passed 3/3 on `H:` (2 via a throwaway comparison script, 1 via the real `Test-TableCore.mjs` after wiring the opt-in override — see F/H). This is the strongest single piece of evidence in this investigation.
- Both volumes are the **same SSD model** (`SPCC Solid State Disk`, SATA) on **different physical disks** (Disk 0 vs Disk 1) with very different fill levels (`C:` ~70% full, `H:` ~0% full). The investigation cannot distinguish between "different physical disk instance" and "fill-level-dependent SSD behavior" as the deeper explanation — both remain open.
- No checkpoint storm, no blocking PID, no low disk space, no OneDrive/junction/compression, no antivirus exclusion mismatch, and no CPU/disk-queue contention were found correlating with the stall. Real-time Defender protection is on and unchanged; whether it is a contributing factor is **unknown** — no evidence collected here confirms or rules it out, and it was not disabled to test this.

## F. Alternate-volume comparison

Performed (H: drive, a second local fixed NTFS volume, ~256GB, nearly empty, confirmed present and suitable):

1. 40-cycle isolated `Profile-TestStorage.mjs` run — see C.
2. Real `tests/integration/*` regression group (47 tests, 6 files) via a disposable cluster on `H:` — 47/47 PASS, 38.1s (vs ~51-56s typically on `C:`).
3. Real exact `combined` selection (69 tests, 7 files, the ONLY selection that has ever reproduced the stall) via a disposable cluster on `H:` — **69/69 PASS**, run twice (54.9s, 56.0s).
4. After adding the `RCS_TEST_PG_DATA_DIR` override (see H), the same combined selection was run a third time through the *real* `apps/print-agent/Test-TableCore.mjs` tooling pointed at a persistent `H:\rcs-postgres-test-data` cluster — **69/69 PASS**, 53.3s.

WSL/Linux comparison (section 7 of the task): not performed. No existing, already-installed, immediately-usable WSL2/Linux Postgres environment was found in this session; per instructions, no new large infrastructure was installed to test this path. Reported as unavailable, not attempted.

## G. Root-cause confidence classification

**STRONG EVIDENCE** that the stall is tied to the specific default storage volume/disk (`C:`, Disk 0) on this machine, under the concurrent multi-process load produced only by the full combined integration run — not **CONFIRMED ROOT CAUSE**, because:

- The deeper mechanism (disk-instance-specific degradation vs. fill-level-dependent SSD write-amplification/GC behavior vs. some other Disk-0-specific factor) was not isolated further.
- The sample size, while real and repeated (4 failures on `C:`, 3 passes on `H:`), is still modest — a larger sample would strengthen this further, but was intentionally not pursued to avoid "hammering" retries per instructions.
- Windows Defender's specific behavior on this path could not be fully confirmed or ruled out without administrator access.

This is **not** "LIKELY BUT UNPROVEN" or "UNKNOWN" — the volume correlation is a real, repeated, controlled A/B result on identical code, settings, and workload, which is materially stronger than a hunch.

## H. Recommended infrastructure fix

**B — move the local TEST PostgreSQL data directory to the alternate reliable local fixed volume**, implemented as an **opt-in, backward-compatible override** rather than a new hardcoded default:

- `scripts/lib/local-test-db.mjs`: `TEST_DB.databaseDir` now reads `process.env.RCS_TEST_PG_DATA_DIR` first, falling back to the exact original `.local-postgres-data-test` path when unset. **No behavior changes for any developer or CI environment that doesn't set this variable** — a hardcoded `H:\...` default would have silently broken test infrastructure on any machine without that exact drive letter, so this was deliberately not done.
- To use the more reliable volume on this machine: set `RCS_TEST_PG_DATA_DIR=H:/rcs-postgres-test-data` (or any other suitable local fixed path) in the shell/environment before running `npm run test:integration` or any `apps/print-agent/*.mjs` tool. Nothing else changes — same port, same credentials, same migrations, same marker table, same fail-closed reset logic, same durability settings.
- This was not made the new default, and no shell profile was modified — that decision is left to you.

## I. Validation after the infra fix (with `RCS_TEST_PG_DATA_DIR` set to the H: path)

- A. New printing hardening group: 22/22 PASS.
- B. Repeat: 22/22 PASS.
- C. Existing regression group: 47/47 PASS.
- D. Exact combined selection: **69/69 PASS** (via the real `apps/print-agent/Test-TableCore.mjs`, not a throwaway script).
- DB safety-gate unit tests: 6/6 PASS (part of the 316/316 full unit run below; unaffected by this change).
- Full unit suite: 316/316 PASS.
- `prisma validate`: valid.
- Typecheck (`apps/web`): clean.
- Lint: clean.
- Production build: succeeds.
- Migration verification (`Verify-Migrations.mjs`, run against the *default*, unset-override path to confirm backward compatibility): PASS.
- `git diff --check`: PASS.

## J. Safety guarantees preserved

- `fsync`, `full_page_writes`, `synchronous_commit` were never changed — confirmed `on` throughout, on both volumes.
- The fail-closed reset harness (`tests/setup/reset-test-db.ts`) was not modified in this investigation.
- No sleeps added, no automatic retries of destructive resets, no timeout increases to hide the issue.
- `RCS_TEST_PG_DATA_DIR` only ever selects a *local* path used by the exact same TEST-only tooling (same port, credentials, marker-table check, safety gates) — it cannot point at Development/Production, and nothing here accepts an externally supplied database URL.
- Development and Production databases were never touched.

## K. Limits and what was not done

- Root cause is not fully mechanistically explained (see G) — only the correlation with the volume is established with real, repeated evidence.
- WSL/Linux comparison was not performed (unavailable in this session without new installation).
- Windows Defender exclusion contents could not be fully enumerated without administrator rights.
- No permanent change to any developer's default environment was made.
