# TableCore Print Agent — consolidation & controlled pilot preparation (2026-09-09)

**P. READY / NOT READY TO PUSH FOR PREVIEW PILOT: READY.** Six local
commits created (below), all validation green, no secrets found, no
Development/Production migration applied. **Not pushed** — stopping here
per instruction.

## A. Repository audit findings

Audited every uncommitted file across Phase 1 → prerequisite hardening →
TEST DB work → Phase 2A/2B/2C (49 paths, expanding to 87 once
`apps/print-agent/`'s real file list was resolved via `git add --dry-run`).

- `apps/print-agent/.tools/` (a full local, portable .NET SDK/telemetry
  cache pulled down for offline builds) is correctly excluded by the
  existing `.gitignore` — confirmed via dry-run add, never appeared in the
  staged list.
- Found and fixed a **stale, contradictory** file:
  `apps/print-agent/Properties/PublishProfiles/WindowsX64.pubxml` still
  said `PublishSingleFile=false`, left over from before the csproj's
  Release `PropertyGroup` was introduced. It's unused by the actual publish
  command (`dotnet publish -c Release`, no `-p:PublishProfile=`), but
  leaving it wrong was a real trap for the next person who tries it.
  Updated to match reality instead of deleted, since it's legitimate
  publish-profile tooling, just inaccurate.
- `apps/print-agent/HARDWARE-TEST.md` had a hardcoded developer path
  (`C:\Users\PC\restaurant-pos-system\...`) in an example command —
  genericized to `<repository-checkout>`.
- Nothing was deleted for being "just diagnostic": `AUDIT.md`,
  `COMPATIBILITY.md`, `HARDWARE-TEST.md`, `PHASE2.md`, `Test-Api.ps1`,
  `Test-TableCore.mjs`, `Verify-Migrations.mjs`, `Profile-TestStorage.mjs`
  are all kept and classified (historical design/audit record, or still-live
  diagnostic tooling for the legacy `--serve` path). Three of the historical
  docs (`HARDWARE-TEST.md`, `COMPATIBILITY.md`, `PHASE2.md`) got a short
  pointer note added at the top where their conclusions are now superseded
  by real Phase 2C evidence, so a future reader isn't misled — content
  otherwise untouched.
- `apps/print-agent/README.md` was Phase-1-only and dangerously stale
  (described `%LOCALAPPDATA%`/`CurrentUser` DPAPI, which is no longer true;
  had no mention of the Windows Service, installer, or Admin pairing at
  all). Rewritten as the current, primary operational reference — see
  section G.

## B. Secret scan

Scanned every file that would actually enter git (`git add --dry-run -A`,
87 paths) for: `tcpa1_` credential values, literal `Authorization: Bearer`
headers, `DATABASE_URL=`/`DIRECT_URL=`/`AUTH_SECRET=` assignments, Postgres
connection strings, real pairing codes, JWT/API-key-shaped strings,
`C:\Users\PC` and `H:\` paths, and certificate/private-key files.

**No real secret found.** Findings, each distinguished from an actual
secret:
- `packages/auth/workstation-auth.ts:28` — a truncated *format example* in
  a doc comment (`"tcpa1_9f2K3zQ8mN..."`), not a real credential.
- `scripts/lib/local-test-db.mjs` and `apps/print-agent/Profile-TestStorage.mjs`
  contain the literal `rcs_test` / `rcs_test_password` — the project's
  established, already-in-git-history, local-only embedded-Postgres test
  credential (binds to `127.0.0.1` only, used solely for disposable test
  databases). Not new to this work, not a real secret, not something that
  can reach Development/Production.
- `apps/print-agent/installer/TableCorePrintAgent.iss` contains a
  `{{GUID}}` — the Inno Setup `AppId`, a public, non-secret product
  identifier (standard convention), not a credential.
- The three generated test pairing codes actually used this session
  (during live acceptance testing) do **not** appear in any file that would
  be committed — they only ever existed in disposable local test databases
  and gitignored scratch artifacts.
- `C:\Users\PC\...` and `H:\rcs-postgres-test-data` appear **only** in three
  `.md` investigation-history documents (never in any code file) — verified
  separately. They're accurate historical records of what was actually run
  for reproducibility, not secrets, and the actual code never hardcodes
  either path (both are opt-in environment overrides with repo-relative
  defaults).
- No `.pfx`/`.pem`/`.key`/`.cer` file or `-----BEGIN` marker anywhere.
- Also scanned the **built installer binary** itself
  (`strings TableCorePrintSetup.exe | grep ...`) for the same patterns —
  clean.

## C. Generated-file / gitignore findings

`git add --dry-run -A apps/print-agent/` is the authoritative check: only
29 real source/config files would be staged from that directory (`bin/`,
`obj/`, `.tools/`, `artifacts/`, and the installer's `dist/` output are all
already excluded, the last via the **root** `.gitignore`'s `dist/` pattern).

Strengthened `apps/print-agent/.gitignore` with explicit defense-in-depth
patterns for the exact file types called out in the audit —
`*.sqlite3`, `workstation-credential.dat`, `agent.config.json`,
`agent-state.sqlite3`, `installer/dist/` — even though none of them
currently exist inside the checkout (they belong under `ProgramData` on an
installed machine, entirely outside the repo). Re-verified the dry-run add
list is unchanged after adding these (nothing was accidentally already
tracked). No source file, test file, or migration file is ignored anywhere
in the tree.

## D. Endpoint safety confirmation

Re-confirmed `AgentEndpoint.cs` semantics are exactly as required:
Production is always `https://tablecore.net` with no configuration;
`--mode test` requires an explicit non-production `--server`; any
incomplete/malformed/production-pointing test configuration throws
(`AgentEndpointConfigurationException`) rather than silently defaulting.
**Re-verified live this round**: a freshly installed, unpaired service logs
`mode=Production, endpoint=https://tablecore.net` and opens **zero**
network connections (checked via `Get-NetTCPConnection` against the live
service PID) — it genuinely does not talk to the server until paired.
Automated coverage: 12 self-tests in `SelfTests.cs`, still 12/12 passing as
part of the 60/60 total.

## E. Migration audit

All 5 new migrations reviewed line-by-line:

| Migration | Verified |
| --- | --- |
| `20260910000000_print_attempt_hardening` | Additive enum values + columns; conservative backfill of in-flight `PRINTING` rows to a timestamped state, never assumes success/failure |
| `20260910000001_print_attempt_backfill` | Correctly split into its own migration because PostgreSQL cannot use a new enum value in the same transaction that creates it; reconciles ambiguous legacy claims to `SUBMISSION_UNKNOWN`, suppresses `PENDING` automatic jobs where Auto Print was off |
| `20260911000000_workstation_pairing` | New tables/enums/indexes/FKs, correct `ON DELETE` semantics; doc comment transparently discloses unrelated pre-existing schema drift it deliberately did *not* touch |
| `20260912000000_workstation_printer_available` | Single additive nullable column |
| `20260913000000_workstation_test_print` | Five additive nullable columns |

- **Chronological order**: confirmed strictly increasing timestamps, no gaps/collisions.
- **No historical migration edited**: `git status`/`git diff` on `packages/db/prisma/migrations/` before committing showed zero modifications to any pre-existing migration file or `migration_lock.toml`.
- **Fresh deploy works**: proven repeatedly this session and again in this final round — every disposable test database this work touched was built via `prisma migrate deploy` applying all 25 migrations in order from empty, including the final full validation run.
- **Upgrade from pre-print-agent schema works**: a from-empty sequential deploy through all 25 migrations *is* that same incremental path (deploy applies one migration at a time, in order); no separate "start from migration 20 and apply 21-25" run was performed beyond that, since `migrate deploy`'s behavior at that boundary is identical either way.
- **Constraints/indexes/FKs**: correct (checked against the actual SQL above).
- **Legacy PrintJob migration semantics preserved**: the backfill migration explicitly does not resurrect suppressed jobs or assume outcomes.
- All performed against **disposable TEST databases only** (`rcs_phase2c_*`, the shared `rcs_test` cluster) — never Development or Production.

## F. Complete validation results (fresh run, post-consolidation)

| Gate | Result |
| --- | --- |
| C# build | PASS, 0 warnings, 0 errors |
| C# self-tests | **60/60 PASS** |
| Installer build (Inno Setup, pilot version) | PASS |
| Unit tests | **316/316 PASS** |
| Integration tests (`RCS_TEST_PG_DATA_DIR=H:/rcs-postgres-test-data`, fsync/full_page_writes/synchronous_commit all default-on, never weakened) | **852/852 PASS** (57 files) |
| TypeScript typecheck | PASS |
| Lint | PASS |
| Prisma validate | PASS |
| Production Next.js build | PASS |
| Migration verification | PASS (section E) |
| `git diff --check` | Clean (CRLF/LF notices only) |
| Post-commit sanity re-check (typecheck/lint/`dotnet build` against the actual committed HEAD, not just the working tree) | PASS |

No physical printing was repeated — the existing Windows 10 hardware
acceptance (controlled Kitchen ticket + Test Print, both `PRINTED`/
`SUCCEEDED`) from the prior round remains valid evidence and nothing in
this consolidation pass changed the printing code path.

## G. Documentation status

`apps/print-agent/README.md` is now the current, comprehensive operational
reference: architecture, Admin pairing process, installation flow, Windows
Service behavior, printer selection, Test Print, Auto Print ON/OFF
semantics, logs/troubleshooting, uninstall/reinstall, credential/state
preservation, revocation, endpoint modes, Windows 10/11 support status, and
code-signing status — all explicitly stating "restaurant managers must not
need PowerShell," which nothing in the documented flow requires. Historical
docs (`AUDIT.md`, `PHASE2.md`, `COMPATIBILITY.md`, `HARDWARE-TEST.md`) are
kept, cross-linked, and marked where superseded. The full evidence-backed
Phase 2C report and this consolidation report live in `docs/`.

## H. Chosen pilot version

**`1.0.0-pilot.1`** — explicit, not a claim of public stable release.
Made consistent in all four places:

| Where | Value |
| --- | --- |
| `AgentVersion.Current` (`AgentRunner.cs`) | `1.0.0-pilot.1` |
| Heartbeat (reports `AgentVersion.Current`) | `1.0.0-pilot.1` |
| Admin UI (`getAgentDownloadInfo`, `workstation-service.ts`) | `1.0.0-pilot.1` |
| Installer metadata (`MyAppVersion`, `.iss`) | `1.0.0-pilot.1` |
| Binary file properties (`<Version>` in the `.csproj` → EXE Product Version) | `1.0.0-pilot.1+<git-sha>` (MSBuild appends source revision automatically; `FileVersion` is the numeric-only `1.0.0.0`, as Windows file-version fields can't hold a suffix) |

Verified by rebuilding after the change: 60/60 self-tests still pass, the
published EXE's own `ProductVersion` shows the pilot string, and the
installer compiled against it cleanly.

## I. Files included / excluded

**Included** (87 files, across 6 commits — see K): everything under
`apps/print-agent/` except `bin/`, `obj/`, `.tools/`, `artifacts/`,
`agent.local.json`, `installer/dist/`; all new/modified TypeScript, Prisma
schema/migrations, and tests listed in the commits below; four
documentation files in `docs/`.

**Excluded** (never staged, confirmed via dry-run add and the gitignore
audit): the local portable .NET SDK cache, all build/publish output, the
built installer `.exe`, runtime logs, SQLite state, DPAPI credential files,
the local embedded test Postgres data directories (both default and the
`H:\` override), and the dev-only `agent.local.json`.

## J. Local commits created

Six commits, in dependency order. Two deliberate simplifications, disclosed
here rather than left implicit:

1. **`schema.prisma`** is committed once, in its cumulative final form, in
   commit 1 — reconstructing four intermediate snapshots (one per later
   migration) was judged higher-risk than valuable, since this project's
   actual tooling (`prisma migrate deploy`) reads migration SQL files
   directly and doesn't require `schema.prisma` to be in lockstep with
   migration history at every commit boundary. Every individual migration
   file remains correctly ordered and untouched in its own commit.
2. A small number of files that evolved continuously across every phase
   (`workstation-service.ts`, `WorkstationsPanel.tsx`, `AgentRunner.cs`,
   `CredentialStore.cs`, `Program.cs`, etc.) are each committed exactly
   once, in their final form, at the commit representing their primary/
   dominant responsibility — not split into fictional intermediate states
   that were never actually run. `packages/domain/index.ts`, which has two
   genuinely independent one-line exports, *was* split correctly across
   commits 3 and 4 (the only case where doing so was both cheap and
   necessary to avoid an actually-broken intermediate module resolution).

Both were checked for import-order safety (no commit imports a symbol from
a file first introduced in a *later* commit) before committing.

## K. Exact git log for new commits

```
a6f3cda feat(workstations): add Print Agent Admin download and authenticated Test Print
835b573 feat(print-agent): add Windows Service, installer, and endpoint safety
a87e073 feat(workstations): add authenticated Print Agent delivery (poll/claim/print/reconcile)
1c71992 feat(workstations): add secure Print Agent workstation pairing and identity
b4d57a3 test(db): add fail-closed TEST database safety harness and storage diagnostics
b78af71 feat(printing): harden PrintJob delivery with claim/attempt/reconciliation state machine
```

(Full messages carry the "why," not just the "what" — see `git log -p` or
the individual commit bodies.) All on branch `prototype/windows-print-agent`,
sitting on top of the pre-existing `fb9a8b8`.

## L. Exact git status

```
On branch prototype/windows-print-agent
nothing to commit, working tree clean
```

Nothing staged, nothing left uncommitted, nothing pushed.

## M. Controlled pilot rollout plan (ONE supervised restaurant workstation — NOT executed)

1. **Backup/checkpoint**: snapshot/export current Production and
   Development databases through the project's existing backup tooling
   before any server-side change ships toward them; record the exact
   pre-pilot migration head.
2. **Development/Preview migration validation**: apply the 5 new
   migrations to the Development (or a Preview) database specifically —
   not just disposable local test DBs — and confirm `prisma migrate
   status` shows clean, then exercise the same 852-test integration suite
   against it if the environment allows, or at minimum the workstation/
   print-hardening subset.
3. **Deploy server changes to Preview/Development**: ship the 6 commits'
   Next.js/API changes to a Preview deployment (or Development), not
   Production, and not by this session — that requires explicit
   push+deploy approval not yet given.
4. **Verify Admin UI**: confirm Settings → Printers shows the TableCore
   Print Agent panel, download section (honest "not published" state is
   acceptable for this step), and that pairing-code generation works
   against the Preview/Development database.
5. **Upload/host the pilot installer privately**: build the Release
   installer as done in this session, but do **not** publish it broadly —
   share `TableCorePrintSetup.exe` directly with the pilot restaurant (or a
   private, access-controlled link) rather than setting
   `PRINT_AGENT_INSTALLER_URL` to a public location; it remains unsigned,
   so the installing admin must expect and accept one SmartScreen prompt.
6. **Install on one workstation**: the actual target Kitchen PC, following
   the README's Admin pairing process exactly as documented — no
   PowerShell, no manual steps beyond the installer wizard and the Setup
   screen.
7. **Pair KITCHEN only initially**: generate a Kitchen-station pairing code
   from the (Preview/Development-backed) Admin panel, pair, do not yet
   touch Bar.
8. **Verify heartbeat**: confirm the workstation shows "Povezana" in
   Admin within the expected window and `agent.log` shows successful
   heartbeats against the correct (non-production, pilot-target) endpoint.
9. **Verify printer availability**: Admin shows the configured printer as
   available; cross-check against `agent.log`'s printer enumeration line.
10. **Test Print**: use the Admin Test Print button; confirm the physical
    ticket is clearly marked "TABLECORE TEST PRINT" and Admin shows
    `SUCCEEDED`.
11. **Enable Auto Print deliberately**: only after Test Print succeeds,
    an admin explicitly turns Auto Print on for the Kitchen station —
    never automatic, never a side effect of installation or pairing.
12. **Send one controlled real Kitchen order**: a genuine, deliberately
    small/test-flagged order through the normal waiter flow.
13. **Confirm exactly one `PrintJob`** was created for it (no duplicate
    dispatch).
14. **Confirm exactly one attempt** (`attemptCount = 1`).
15. **Confirm exactly one physical ticket** actually came out of the
    printer (visual confirmation by the person present).
16. **Verify KDS still works**: the Kitchen Display still shows/updates
    the order normally — the agent path is additive, not a replacement for
    KDS's own display.
17. **Verify QZ does not race the agent**: with QZ Tray closed (or, as a
    stricter check, left open but unused) for this station, confirm no
    second/duplicate ticket appears — the existing exclusivity expectation
    holds under real conditions, not just in the isolated test this
    session already ran.
18. **Restart the browser** (the KDS/Admin browser tab, not the OS): confirm
    the print agent's operation is entirely unaffected — it never depended
    on a browser tab.
19. **Restart the Windows Service** (`services.msc` or equivalent) on the
    pilot workstation: confirm clean stop/start, printer still enumerates,
    heartbeat resumes.
20. **Reboot the workstation** entirely: confirm the service auto-starts
    before any user logs in and resumes normal operation without manual
    intervention.
21. **Repeat one controlled order** after the reboot.
22. **Verify no duplicates**: re-check `PrintJob`/attempt counts for the
    post-reboot order exactly as in steps 13-15 — this is the real proof
    that startup reconciliation behaves correctly outside a lab test.
23. **Rollback procedure defined**: see N below, and confirm the pilot
    restaurant/admin knows how to invoke it (turn Auto Print off, or
    revoke the workstation) without needing developer involvement.

This plan is **not executed** — preparation only, per instruction.

## N. Rollback plan

Layered, cheapest/least-disruptive first:

1. **Turn Auto Print off** for the affected station (Admin → Settings →
   Printers). Immediate, reversible, requires no agent/service change.
   KDS continues working exactly as before Auto Print was enabled — this
   was explicitly preserved behavior (see the PrintJob hardening commit).
2. **Revoke the workstation** (Admin → workstation row → Opozovi) if the
   agent itself is suspect. Immediate and permanent for that credential;
   the workstation stops being able to claim jobs at all. Re-pairing (a
   fresh code) is required to bring it back — this is intentional
   (revocation is a hard security boundary, not a pause button).
3. **Stop the Windows Service** on the pilot machine
   (`services.msc` → "TableCore Print Agent" → Stop) if a local,
   machine-specific problem needs to be isolated without touching server
   state at all. The KDS/manual print paths are unaffected.
4. **Uninstall the agent** from the pilot workstation if a clean full
   stop is needed. Default behavior **preserves** `ProgramData` (credential/
   state/logs) so re-installing later does not require re-pairing; a
   deliberate interactive choice during uninstall can also fully wipe it.
5. **Database rollback**: the 5 new migrations are purely additive (new
   tables, new nullable columns) — they do not alter or remove any
   existing column, constraint, or row. No destructive rollback migration
   is needed to protect existing data; if the *feature* needs to be fully
   retracted from Development/Preview, the added tables/columns can be
   left in place inert (nothing reads them unless a workstation is paired)
   rather than requiring a down-migration.
6. **Code rollback**: since nothing has been pushed, the six local commits
   can be reset/dropped entirely with zero deployed footprint if a
   decision is made not to proceed at all. Once pushed to Preview/
   Development (step M.3), rollback there is a normal revert/redeploy,
   not a data-destructive operation.

At every layer, the failure mode is "printing stops working for that
station" (loud, immediately visible to staff) — never "silent duplicate
tickets" or "silent data loss," by the same design already proven in the
attempt/claim/reconciliation hardening.

## O. Remaining public-release blockers

Unchanged from the Phase 2C report, still accurate:

1. **Authenticode code signing** — no certificate exists; the installer is
   unsigned. Required before any unattended/public distribution.
2. **Real Windows 11 hardware acceptance** — no such hardware is available
   in this environment; explicitly marked pending, not claimed.
3. **Public installer hosting decision** — `PRINT_AGENT_INSTALLER_URL` is
   unset; Admin UI correctly and honestly shows "not published here yet."
   For the pilot specifically, private direct distribution (M.5) sidesteps
   this without requiring it to be resolved first.

---

**No push. No deploy. No Development migration applied. No Production
migration applied.** Stopping here for review, as instructed.
