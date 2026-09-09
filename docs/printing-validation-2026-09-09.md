# Printing prerequisite validation — 2026-09-09

**Result: NOT READY for Phase 2.** The combined run reproduced a reset timeout. Stopped after collecting that invocation's diagnostics; no retry, timeout increase, durability change or production printing change was made.

## Exact failure and evidence

The previously failing file was `tests/integration/print-hardening.test.ts`: the own-location configuration case timed out in its top-level `beforeEach`, at `resetPrismaTestTables(prisma, "tenants, permissions, login_throttles")`.

This turn reproduced the same operation in `tests/integration/print-reprint.test.ts`, first case `leaves Order/Payment/Receipt totals byte-for-byte unchanged after a reprint`. The reset is a single awaited `$executeRawUnsafe` call in `tests/setup/reset-test-db.ts`:

```sql
TRUNCATE tenants, permissions, login_throttles CASCADE
```

Vitest reported `Hook timed out in 30000ms` (30,012 ms in the failing case). There was no PostgreSQL SQL error code: PostgreSQL continued executing the statement after the JavaScript hook timed out.

The read-only 200 ms sampling trace in `apps/print-agent/artifacts/combined-1788950766275.json` establishes this sequence (UTC):

- At 10:44:48.851, backend 22216 was already 1,105 ms into reset, waiting on `IO / DataFileImmediateSync`, with no blocking PID.
- At 10:45:07.792, that same reset had run for 20,044 ms, still waiting on `DataFileImmediateSync`, with no blocker.
- At 10:45:17.964, after the 30-second hook deadline, a second reset on backend 16748 was 190 ms old and waiting on a relation lock held by 22216.
- The first reset was still active at 32,659 ms. The second was observed active up to 24,221 ms, including its initial lock wait and subsequent disk synchronization.

This proves an initial database file synchronization stall, followed by a secondary harness problem: timing out a hook does not cancel its outstanding reset. The next test begins while that SQL can still be running. It does **not** prove a particular Windows disk, filter driver or antivirus component caused the I/O latency. No application assertion caused the failure, but the continued reset is an isolation risk and is not treated as harmless.

## Reproduction matrix

No tests/builds ran concurrently with these database suites.

| Command | Tests | Vitest duration | Result |
| --- | --- | --- | --- |
| `node apps/print-agent/Test-TableCore.mjs isolated` — first run | All 22 new integration cases | 20.17 s | 22/22 PASS |
| Same isolated command — second run | All 22 new integration cases | 20.26 s | 22/22 PASS |
| `node apps/print-agent/Test-TableCore.mjs regression` | Existing printing + multi-round regressions | 56.20 s | 47/47 PASS |
| `node apps/print-agent/Test-TableCore.mjs` | Exact intended combined selection | 123.50 s | 68/69; one reset-hook timeout |

Observed timeout rate this turn: isolated 0/2, regression group 0/1, combined 1/1. This small sample demonstrates reproduction, not a statistical long-term rate. All 22 new cases passed in the combined run too; the failure moved to existing receipt reprint setup.

## Database and concurrency audit

- Owned TEST cluster only: `127.0.0.1:55433`, `rcs_test`, `.local-postgres-data-test`.
- Database approximately 18.4 MB (18,381,847 bytes before combined; 18,416,143 after); 46 public tables.
- `fsync=on`, `full_page_writes=on`, `synchronous_commit=on`, unchanged before/after.
- At most five test connections observed; monitor uses one additional connection. No accumulating connection leak was observed.
- Integration configuration already has `fileParallelism:false`. The selected files contain no concurrent test declarations. Their intentional concurrent claim calls are inside individual tests, not concurrent reset hooks.
- Maximum active resets: one in isolated/grouped runs; two only after the combined hook timeout, as shown above.
- No blocker preceded the long first reset. Short business transactions were observed; no abandoned long business transaction explained the stall.
- No checkpoint ran during combined validation: requested checkpoints remained 1, timed checkpoints 0; checkpoint write/sync counters remained 3/6 ms. Backend buffers written increased from 3 to 98,307. The measured wait was immediate file synchronization, not a demonstrated checkpoint storm.
- The reset helper opens no extra transaction, starts no parallel query and performs no retry. The tenant-root cascade intentionally clears related fixture data; migrations and the test marker remain. Narrowing its scope has not been justified.
- No evidence justified changing global worker/concurrency settings. Serial execution already exists; timeout cancellation is a separate concern.

## Changes in this turn

- `apps/print-agent/Test-TableCore.mjs`: added fixed isolated/regression selections, asynchronous direct Vitest invocation to permit monitoring, timing/log capture and read-only database diagnostics. Default test selection remains the same. Artifacts are ignored by Git.
- `apps/print-agent/Verify-Migrations.mjs`: added reproducible verification using a randomly named, script-created database on the owned TEST cluster. It accepts no external URL and removes only that database afterward.
- This report.

No reset helper, safety gate, timeout, durability setting, concurrency configuration, application hardening or migration SQL was changed.

## Migration verification

Passed from the expected prior schema: deployed the first 20 migrations to a fresh script-created TEST database, marked it, inserted legacy fixtures, then deployed both new additive migrations. Verified:

- Legacy PRINTING -> SUBMISSION_UNKNOWN with submission timestamp/outcome retained for reconciliation.
- Automatic PENDING with explicit OFF -> SUPPRESSED.
- Legacy PRINTED and FAILED remain final; attempt counters and frozen JSON stay unchanged.
- Existing order/dispatch-key uniqueness, location/station uniqueness, status/tenant indexes, order FK and reprint FK exist.

An initial verifier bootstrap put the test marker into the empty schema too early and correctly received Prisma P3005. The verifier was corrected to match the established runner order: initial migrations, then marker, then fixtures. No baseline shortcut, safety bypass or migration edit was used. The subsequent complete migration verification passed and its disposable database was removed.

## Other validation

- 49 print/browser/QZ unit tests PASS (including six new client protocol tests).
- Six database safety-gate unit tests PASS; their expected rejection banners are successful negative tests.
- 20 Print Agent self-tests PASS; no physical printing attempted.
- Typecheck, lint, Prisma validate, production build PASS. Build uses the isolated test URL and external Redis configuration disabled.
- Git diff inspected; `git diff --check` passes. Existing uncommitted hardening/Phase 1 work remains in place.
- No Development/Production database, Vercel setting, deployment, commit or push was touched.

## Proposed next infrastructure work — not implemented

1. Make destructive-reset timeout handling fail closed: cancel/drain the outstanding reset (or end its dedicated backend) and abort the suite before another fixture can start. A hook timeout alone is insufficient. Preserve marker/identity checks and await confirmed cleanup; do not add automatic reset retries or sleeps.
2. Profile the TEST cluster's Windows storage/file synchronization latency. If confirmed host-specific, run the same isolated PostgreSQL version on a reliable local volume or supported Linux test runner with durability ON and the same safety gates. Do not assume antivirus is responsible or disable it speculatively.
3. Repeat this matrix and require a fully green combined run before approving Phase 2.
