# TableCore Print Agent — Phase 2C report (2026-09-09)

**Verdict: READY for controlled deployment discussion, with two explicit gates before public release: code signing, and physical Windows 11 hardware acceptance (currently PENDING — no hardware available).**

No push. No deploy. No migrations applied to Development or Production. This
report covers the Phase 2C "installer + Windows startup model + Admin
onboarding + release packaging" work, plus the follow-up server-endpoint
safety fix requested after an acceptance-testing incident (see sections X/Y).

---

## A. Final Windows architecture

**Windows Service** (`TableCorePrintAgent`, hosted via
`Microsoft.Extensions.Hosting.WindowsServices`, `BackgroundService` wrapping
the same `AgentRunner.Run` loop proven in Phase 2B) **+ an on-demand WinForms
Setup screen** (`SetupForm.cs`) launched by double-clicking the installed EXE
or the Start Menu shortcut. No persistent tray icon.

Single EXE, mode-dispatched in `Program.cs`:
- Launched by SCM (`WindowsServiceHelpers.IsWindowsService()`) → Windows Service.
- `--self-test` / `--list-printers` / `--pair` / `--heartbeat` / `--run` / `--probe-printer` / `--serve` → internal/dev CLI paths (unchanged from Phase 2B, `--serve` added to make the old Phase 1 Kestrel listener opt-in instead of a silent fallback).
- No args, or only `--mode`/`--server` → interactive WinForms Setup screen.
- Anything else → explicit "unknown option" error, exit 1.

## B. Service/tray rationale

A persistent tray app was rejected: it would be a second autostart
mechanism alongside the service, adding complexity (two processes to keep in
sync, two failure modes) for no functional gain — the restaurant manager
only ever needs the Setup screen during initial pairing or rare
reconfiguration, not a live status icon. The Setup screen satisfies that
need on demand, launched from the Start Menu, without running unnecessarily
in the background.

## C. DPAPI scope

Changed from `CurrentUser` (Phase 2A/2B, correct for a foreground
user-run process) to **`LocalMachine`**. Reason: the interactive Setup
screen runs as whatever Windows account is logged in; the Windows Service
runs under a different, non-interactive account (see D). `CurrentUser`-scoped
DPAPI ties the encrypted blob to the specific account that encrypted it —
a credential paired via the Setup screen would be undecryptable by the
service, and vice versa, since they are provably different Windows
principals.

**Compensating control (security tradeoff, documented in code in
`CredentialStore.cs`):** `LocalMachine` scope alone lets *any* process on the
machine decrypt the blob, regardless of Windows account — weaker than
`CurrentUser`'s per-account isolation. Mitigated with an explicit NTFS ACL on
the credential file, applied on every `Save()`: Administrators, SYSTEM, the
service's own virtual account, and the specific Windows account that most
recently wrote the file (so pairing never requires "Run as Administrator" —
whoever pairs the station can read back what they wrote). A *different*
Windows account on a shared machine still cannot read the file.

## D. Installer technology

**Inno Setup 6** (installed via winget for this build). Chosen over
WiX/MSIX as the simplest reliable option that supports everything required:
Program Files install, `sc.exe`-based service registration/removal in
`[Run]`/`[UninstallRun]`, a Pascal Script uninstall hook for the
preserve-vs-cleanup credential decision (section M), and silent
(`/VERYSILENT`) operation for scripted acceptance testing.

Script: `apps/print-agent/installer/TableCorePrintAgent.iss`.

## E. Release packaging

Self-contained, single-file, win-x64 publish
(`dotnet publish -c Release`, `SelfContained=true`,
`RuntimeIdentifier=win-x64`, `PublishSingleFile=true`,
`IncludeNativeLibrariesForSelfExtract=true` — required for
`Microsoft.Data.Sqlite`'s native `SQLitePCLRaw` component to extract
correctly from a single-file publish; without it, SQLite would silently
break only in the published artifact, never in `dotnet run`).

**Verified, not assumed**: the published `TableCore.PrintAgent.exe`
(~79–84 MB) ran all 35 (later 60) self-tests standalone with `dotnet`
removed from PATH, proving true self-containment. These `SelfContained`/
`RuntimeIdentifier`/publish settings are scoped to the `Release`
configuration only, so day-to-day `dotnet build`/`dotnet run` in `Debug`
stays fast and framework-dependent.

These settings were deliberately **not** made unconditional in the csproj —
only `Release` builds pay the self-contained publish cost.

## F. Program/state/credential/log paths

Centralized in `AgentPaths.cs`:

| What | Path |
| --- | --- |
| Installed binary | `C:\Program Files\TableCore\PrintAgent\TableCore.PrintAgent.exe` |
| Config (station/printer/paper width) | `C:\ProgramData\TableCore\PrintAgent\agent.config.json` |
| Credential (DPAPI-protected) | `C:\ProgramData\TableCore\PrintAgent\workstation-credential.dat` |
| Durable delivery state (SQLite) | `C:\ProgramData\TableCore\PrintAgent\agent-state.sqlite3` |
| Logs | `C:\ProgramData\TableCore\PrintAgent\logs\agent.log` (+ `.log.1` rotated at 2 MB) |

`ProgramData`, not `LocalAppData` (Phase 2A/2B) or the source checkout — a
service account has no meaningful per-user profile, and `ProgramData` is the
standard machine-shared location both the service and the interactive Setup
screen can reach.

**Real bug found and fixed via acceptance testing** (not by inspection): a
SQLite state file first created by a `--self-test` run (owned by the dev
Windows account) was then opened by the real service under its own,
different virtual account and failed with `SQLite Error 8: attempt to write
a readonly database` — NTFS's default `ProgramData` inheritance only
propagates *read* rights to new files, not write, for the generic `Users`
group. Fixed in `AgentPaths.EnsureProgramDataDirectory()`: an explicit
directory ACL (Administrators/SYSTEM full control, `Users` Modify, both
Object+Container inherited) so any identity that touches this directory
first still leaves it usable by any other. Confirmed fixed by deleting the
stale file and rerunning the real service, which then created a properly
permissioned replacement.

## G. Startup/recovery

- Service `start=auto` — starts before user logon, survives logout/login (proven: enumerated printers correctly with no interactive session at all, running purely as a service).
- **Fresh install before pairing is not an error.** `AgentService.ExecuteAsync` waits in a 30-second poll loop for `CredentialStore.HasStoredCredential()` rather than throwing — avoids the explicitly prohibited "tight crash-restart loop" for the completely normal state of "just installed, not yet paired."
- Once paired, genuine unexpected errors propagate and terminate the process; **Windows Service recovery** (configured by the installer via `sc failure`) restarts with escalating delays: 60s → 120s → 300s, failure counter reset after 24h with no further failures — bounded, not tight.
- Network loss, TableCore outage, or printer unplugged: `AgentRunner`'s existing Phase 2B per-step try/catch (unchanged) logs and retries on the next poll/heartbeat cycle; no crash.

## H. Printer visibility under service identity — proven, not assumed

**This was the single most evidence-critical item and required real,
iterative testing on the physical Windows 10 workstation, not
Phase 2B foreground-process results:**

1. `NT AUTHORITY\NetworkService` and `NT AUTHORITY\LocalService` both failed to **start** at all (`Access is denied`, confirmed via Windows Event Log from the Service Control Manager itself). Root cause, confirmed via `secedit /export /areas USER_RIGHTS`: this machine's "Log on as a service" right (`SeServiceLogonRight`) is explicitly scoped to `*S-1-5-80-0` only — the per-service virtual-account group — and does **not** include the two legacy built-in accounts.
2. The modern **per-service virtual account**, `NT SERVICE\TableCorePrintAgent`, *is* covered by that right — but initially also failed with `Access is denied`, this time for an unrelated reason.
3. Isolated the second cause by copying the identical binary to `C:\Program Files\TableCoreTest\` (a system-readable location) instead of the original `C:\Users\PC\...` dev path: **both** `NetworkService` and the virtual account then started cleanly. A user-profile directory's NTFS ACL does not grant service accounts traversal/read; `Program Files` does.
4. With the binary in a system location, `LocalSystem`, `NetworkService`, and the per-service virtual account **all enumerated the identical 14 printers**, including the real `POS-58 (1)`, confirmed via `agent.log`. Printer visibility for this local USB thermal printer is not identity-dependent once the process can even start.

**Final choice: `NT SERVICE\TableCorePrintAgent`** — least privilege that
actually works on this class of hardened Windows configuration (uniquely
scoped SID, not shared with any other `NetworkService`-hosted process on the
box), installed to Program Files. Confirmed again on a **fresh install using
the actual built installer** in this follow-up round: service starts,
enumerates all 14 printers including `POS-58 (1)`, logs `mode=Production,
endpoint=https://tablecore.net`, and — because it is not yet paired — opens
**zero** network connections (verified via `Get-NetTCPConnection` against
the live service PID).

## I. Pairing UX

WinForms Setup screen (`SetupForm.cs`): pairing-code entry, station/
printer/paper-width dropdowns (populated from `WindowsPrinter.Enumerate()`),
Save, Test Print, and a status line ("Povezano sa TableCore: <name>
(<station>)" or "Nije upareno..."). Never displays the raw persistent
credential or its hash — `PairingClient.PairForSetup` returns only
`{Success, Name, Station, ErrorMessage}`. A second status line shows the
active server endpoint (`mode=Production/Test, endpoint=scheme://host`) —
added in the follow-up round so a manager or support engineer can visually
confirm which server the station is talking to (section X, requirement 8).

## J. Admin download/setup UX

`WorkstationsPanel.tsx` extended with:
- A "TableCore Print Agent — instalacija" download section, backed by `GET /api/admin/workstations/agent-download`. No binary in Postgres (`getAgentDownloadInfo` reads only an optional `PRINT_AGENT_INSTALLER_URL` env var); when unset, the panel honestly shows "not yet published for download here" instead of a broken/fabricated link.
- Everything else required (agent version, Connected/Offline, printer configured/available, last seen, last successful communication) already existed from Phase 2A/2B — extended, not rebuilt.

## K. Test Print

Fully **authenticated workstation path**, per the explicit new requirement
— not a bare local print call:

1. Admin clicks "Test Print" on a workstation row → `POST /api/admin/workstations/[id]/test-print` → `workstations.requestTestPrint` sets `testPrintStatus=PENDING` on the `Workstation` row. **No PrintJob, no Order row is created or touched** — `PrintJob.orderId` is a required FK, so this is structurally impossible even by accident; a dedicated set of nullable `testPrint*` columns on `Workstation` was added instead (migration `20260913000000_workstation_test_print`).
2. The agent's **existing** heartbeat cycle (no new poll endpoint) now returns `testPrintRequested: boolean`. On `true`, `AgentRunner.HandleTestPrintRequest` prints locally via the same `WindowsPrinter.Print` path as real tickets, using `Ticket.TestPrint(workstationName, station, printer, paperWidthMm, agentVersion)` — explicitly marked **"TABLECORE TEST PRINT"**, and includes workstation name, station, printer, paper width, agent version, and a timestamp (all asserted by self-tests).
3. The agent reports the outcome via the authenticated `POST /api/agent/test-print/result`, which the Admin panel then displays (`Test štampa uspela`/`nije uspela`, with the agent-reported error).

**Physically verified this round**: requested via the real
`requestTestPrint` domain function, agent (running from the actual
installed, self-contained binary) picked it up on its next heartbeat,
printed one physical ticket to `POS-58 (1)`, and the server-side row shows
`testPrintStatus: "SUCCEEDED"`, `testPrintCompletedAt` set,
`testPrintError: null`.

## L. Upgrade behavior

Installer `[Run]` section stops/deletes/recreates the service on every
install (idempotent, no "service already exists" error on upgrade);
`ProgramData` (credential, config, SQLite state, logs) is never touched by
the installer. **Verified twice this phase**: credential file's
`LastWriteTime` was byte-for-byte identical before and after a real
installer-driven upgrade; service came back up and continued working
without re-pairing.

## M. Uninstall behavior

**Preserve by default**, per the explicit instruction ("accidental
credential loss forces re-pairing"). `[UninstallRun]` stops/deletes the
service and removes the Program Files binaries; a Pascal Script hook in the
uninstaller (`CurUninstallStepChanged`) asks, interactively, whether to also
delete `ProgramData\TableCore\PrintAgent` — default answer (and the
guaranteed answer under `/VERYSILENT`, via an explicit `UninstallSilent`
guard added this round) is **No, preserve**. **Verified twice this phase**
with the real uninstaller: service removed, Program Files removed, Start
Menu shortcuts removed, `ProgramData` (credential/config/state/logs)
untouched.

## N. Logging/security review

`AgentLog.cs` — simple append-file logger with 2 MB rotation
(`agent.log` → `agent.log.1`), used from both `AgentService.cs` (service
lifecycle, printer enumeration, active endpoint, pairing-wait state) and
`AgentRunner.cs` (every `Console.WriteLine`/`Console.Error.WriteLine` now
also routes through it via `LogInfo`/`LogWarn`, so the `--run` CLI path is
unchanged and the service — which has no console — gets the same
information in `agent.log`).

Logged: version, OS, running account, printer enumeration, active endpoint
(mode+host), pairing-wait state, heartbeat/poll network errors, `jobId`/
`attemptId` (never ticket content), printer-unavailable warnings, submission
outcomes, reconciliation on startup, Test Print requests/outcomes.

**Never logged** (verified structurally, not just by convention): the raw
bearer credential, the pairing code (only consumed once, server-side,
before any client-visible response), `AUTH_SECRET`, database URLs, ticket
content. `AgentEndpoint.DescribeForLog()` — the one place server identity is
logged — only ever reads `Mode`/`BaseUrl`; the type has no credential field
to leak, which a self-test asserts by regex-matching its exact output shape.

## O. Code-signing status

**No Authenticode certificate exists on this machine or in this project**
(checked `Cert:\CurrentUser\My` and `Cert:\LocalMachine\My` for anything
with the Code Signing EKU — none found). The installer is built and
**shipped unsigned** for this internal acceptance round.

**CODE SIGNING REQUIRED BEFORE PUBLIC RESTAURANT DISTRIBUTION.**

What signing would require, concretely:
- An Authenticode code-signing certificate from a public CA (e.g.
  DigiCert, Sectigo) or, preferably for a product distributed to many
  independent machines, an **EV (Extended Validation) code-signing
  certificate** — EV certificates get near-immediate SmartScreen reputation;
  standard OV certificates build reputation slowly via download-volume
  telemetry, meaning early downloads of a *newly signed but low-volume*
  installer can still show a SmartScreen warning even though it's signed.
- `signtool.exe sign /fd SHA256 /a /tr <RFC3161 timestamp server> /td SHA256 TableCorePrintSetup.exe` (or add `SignTool=` to the `.iss` so Inno signs automatically as part of compilation).
- Without any signature at all, every install today shows a full
  SmartScreen "Windows protected your PC" block requiring "More info → Run
  anyway" — acceptable for controlled internal testing, not for restaurant
  managers installing unattended.
- Internal acceptance testing in this report was **not** blocked on the
  absence of a certificate, per instruction — an unsigned build is
  sufficient and correct for this stage.

## P. Windows 10 installer acceptance — PASS

Performed twice this phase, using the **actual built
`TableCorePrintSetup.exe`** (never `dotnet run`, never a dev environment),
silently (`/VERYSILENT`) and elevated:

- Clean install → Program Files + ProgramData created, service registered `AUTO_START` under `NT SERVICE\TableCorePrintAgent`, Start Menu shortcuts created.
- Service auto-starts immediately post-install, no reboot needed to observe it (also implied by `start=auto`, which does survive reboot by definition of the SCM start type — a full physical reboot was not additionally performed this round, having already been logically covered by `AUTO_START` + the SCM recovery policy tests).
- Printer enumeration: 14 printers including `POS-58 (1)`, logged at every service start.
- Active endpoint correctly logged and defaults safely to production with **zero** network activity while unpaired.
- Pairing via the installed binary (CLI `--pair`, and the same code path the WinForms Setup screen calls) — succeeds, credential written and DPAPI round-trips.
- Heartbeat — reaches the server, `printerAvailable`/`agentVersion`/`configuredPrinterName` populate on the `Workstation` row.
- Test Print — one physical ticket, `SUCCEEDED` end to end (section K).
- One controlled Kitchen job — **one** physical ticket, `PRINTED`/`SUBMITTED_TO_SPOOLER`, `attemptCount: 1` (produced in the prior acceptance round this phase; **not repeated** this round per instruction, since nothing about the ordinary Kitchen-print path changed).
- Upgrade — credential/state preserved (section L).
- Uninstall — service/binaries removed, `ProgramData` preserved by default (section M).
- No Chrome/QZ popup at any point — the agent path never touches the browser.

## Q. Windows 11 status — PENDING (no hardware)

**No Windows 11 hardware is available in this environment.** Per
instruction, physical Windows 11 acceptance is **not claimed**. What could
be validated without hardware:
- Build target: `RuntimeIdentifier=win-x64` is the correct, single RID for
  both Windows 10 and 11 x64 — .NET 8 does not need a separate Windows 11
  RID.
- Installer OS support: `ArchitecturesAllowed=x64compatible` /
  `ArchitecturesInstallIn64BitMode=x64compatible` in the `.iss` covers both
  Windows 10 and 11 x64 (and ARM64 Windows 11 via x64 emulation, though that
  path is untested and not claimed).
- No Windows-11-specific API is used anywhere in the agent (Windows Service
  hosting, DPAPI, `PrintDocument`, WinForms — all present and behave
  identically on Windows 11).

**Windows 11 physical hardware acceptance: PENDING.** Must be performed on
real Windows 11 hardware before that specific OS is claimed as supported in
customer-facing material, even though nothing in the design is
Windows-10-specific.

## R. Physical print evidence

Two distinct, deliberate physical prints this phase (plus the ones already
on record from Phase 2B):
1. **One controlled Kitchen ticket**, prior acceptance round this phase, via the actual installed self-contained binary: `PrintJob.status = PRINTED`, `resultOutcome = SUBMITTED_TO_SPOOLER`, `attemptCount = 1`. Not repeated this round (unnecessary, per instruction).
2. **One Test Print ticket**, this round, via the new authenticated Test Print path: agent-reported `SUCCEEDED`, server-side `testPrintStatus: SUCCEEDED`, `testPrintCompletedAt` set. This is new functionality (did not exist before this round) and was correctly exercised physically, not just unit-tested.

No other physical prints were performed. All test PrintJobs/workstations
used disposable, isolated local test databases — never Development or
Production.

## S. Automated validation results

| Gate | Result |
| --- | --- |
| C# build (`dotnet build`) | PASS, 0 warnings, 0 errors |
| C# self-tests (`dotnet run --self-test`, and standalone from the published exe) | **60/60 PASS** (35 from Phase 2A/2B + 25 new: endpoint fail-closed behavior, Test Print ticket content, ProgramData path containment) |
| C# publish (`dotnet publish -c Release`, self-contained win-x64) | PASS, runs standalone with no `dotnet` on PATH |
| Installer build (Inno Setup 6) | PASS, unsigned, no secrets found in a `strings` scan |
| Installer clean install (real `.exe`, silent, elevated) | PASS |
| Pairing via installed agent | PASS |
| Heartbeat | PASS |
| Printer enumeration under final service identity | PASS (14/14, incl. `POS-58 (1)`) |
| Test Print (new authenticated path) | PASS, 1 physical ticket, SUCCEEDED |
| Controlled Kitchen print | PASS, 1 physical ticket, PRINTED (prior round, preserved, not repeated) |
| Service auto-start / recovery config | PASS |
| Upgrade preservation | PASS (x2) |
| Uninstall preservation | PASS (x2) |
| TypeScript typecheck (`npm run typecheck`) | PASS, 0 errors |
| Lint (`npm run lint`) | PASS, 0 warnings |
| Production build (`apps/web`, `npm run build`) | PASS |
| Prisma schema validate | PASS |
| Unit tests (`npm run test:unit`) | **316/316 PASS** |
| Integration tests (`npm run test:integration`, disposable local Postgres) | **852/852 PASS** (57 files; includes the new `workstation-test-print.test.ts`, 9/9) |
| `git diff --check` | Clean (line-ending notices only, no real whitespace errors) |

## T. Files changed (this phase, on top of Phase 2A/2B)

New C# (`apps/print-agent/`): `AgentPaths.cs`, `AgentService.cs`,
`AgentLog.cs`, `AgentEndpoint.cs`, `SetupForm.cs`, plus edits to
`CredentialStore.cs`, `AgentDatabase.cs`, `AgentRunner.cs`, `Program.cs`,
`PairingClient.cs`, `DeliveryClient.cs`, `Printing.cs` (added
`Ticket.TestPrint`), `SelfTests.cs`, `TableCore.PrintAgent.csproj`
(Release publish settings).

New: `apps/print-agent/installer/TableCorePrintAgent.iss`.

TypeScript/Prisma: `packages/db/prisma/schema.prisma` (Workstation
`testPrint*` columns) + new migration
`20260913000000_workstation_test_print`; `packages/shared/
workstation-schemas.ts` (`agentTestPrintResultSchema`); `packages/domain/
workstations/workstation-service.ts` (`requestTestPrint`,
`recordTestPrintResult`, `getAgentDownloadInfo`, `recordHeartbeat` now
returns `{testPrintRequested}`); new routes `apps/web/app/api/admin/
workstations/[id]/test-print/route.ts`, `apps/web/app/api/admin/
workstations/agent-download/route.ts`, `apps/web/app/api/agent/test-print/
result/route.ts`; `apps/web/app/api/agent/heartbeat/route.ts` (returns
`testPrintRequested`); `apps/web/components/kds/WorkstationsPanel.tsx`
(download section, Test Print button/status); new test
`tests/integration/workstation-test-print.test.ts`.

Everything from Phase 2A/2B remains present and untouched in intent
(see the working tree's pre-existing modified/untracked files, unrelated to
this phase's changes).

## U. Development/Production untouched — confirmed

- No `git push`, no deploy, at any point.
- Every migration this phase (`20260913000000_workstation_test_print`) was applied **only** to disposable, uniquely-named local test databases (`rcs_phase2c_*`), created and destroyed by throwaway scripts under `apps/print-agent/artifacts/` (gitignored), using the embedded local test Postgres cluster at `H:/rcs-postgres-test-data` — the same fail-closed harness (`resetPrismaTestTables`, `assertTestDatabaseIsSafe`) used throughout the project. `prisma migrate deploy`/`generate`/`validate` against the real schema file never connects to Development/Production — those commands only touch whatever `DATABASE_URL` is explicitly passed, and every invocation this phase explicitly passed a disposable test URL.
- The one exception, disclosed fully in section Y: a brief, credential-rejected contact with real `tablecore.net` from the installed *service* (not from any script I ran directly) after an `sc config` change silently failed to apply. No production data was read or written.

## V. Exact git status

49 changed paths (`git status --short` — see section T for the ones
relevant to this phase). `git diff --check`: clean (CRLF/LF notices only).
No files staged, nothing committed, nothing pushed.

## W. READY / NOT READY for controlled deployment

**READY** for a controlled, internal, invitation-only pilot deployment
(e.g., one real restaurant, admin-supervised install), **conditioned on**:
1. Accepting the installer is unsigned (SmartScreen will warn; the admin
   must click "More info → Run anyway" once per machine).
2. Windows 11 acceptance being formally re-run once real hardware is
   available, before Windows 11 is advertised as supported.

**NOT READY** for public, unattended restaurant distribution until:
- A code-signing certificate is obtained and the installer is signed (section O).
- Windows 11 physical acceptance passes on real hardware (section Q).
- The release-artifact hosting decision (section 8 of the original spec — GitHub Releases vs. Vercel Blob vs. other) is made and `PRINT_AGENT_INSTALLER_URL` is actually configured; today the Admin panel correctly and honestly shows "not yet published."

---

## X. Endpoint/environment safety fix and tests

**Root cause of the incident** (see Y): the agent had exactly one
`--server <url>` override, string-typed, defaulting silently to
`https://tablecore.net` whenever the flag was absent or unparsed. There was
no concept of "mode," so a caller could accidentally end up pointed at
production with no explicit signal that this was even a choice.

**Fix — `AgentEndpoint.cs` (new file), a small, strongly-typed, fail-closed
resolver:**

```
public enum AgentRuntimeMode { Production, Test }
public sealed record AgentEndpoint(AgentRuntimeMode Mode, string BaseUrl);
```

Rules, all enforced by throwing `AgentEndpointConfigurationException`
(never by silently substituting production):
1. No `--mode` → `Production`, always `https://tablecore.net`. If a `--server` is *also* given and doesn't resolve to the `tablecore.net` host, **reject** — production mode never silently accepts a non-production override.
2. `--mode test` **requires** an explicit `--server <url>`. Missing, empty, malformed, or non-absolute-http(s) → reject.
3. `--mode test --server https://tablecore.net` → **reject** — test mode can never point at production, even if asked to.
4. `DescribeForLog()` exposes only `mode=<X>, endpoint=<scheme>://<host>[:port]` — structurally incapable of carrying a credential, since the type never receives one.

**Wired in at every call site**, never caught-and-defaulted:
- `Program.cs` (`--pair`/`--heartbeat`/`--run`): resolves first, logs the endpoint, exits 1 on failure.
- `AgentService.cs` (the real Windows Service): resolves before any network activity, logs via `AgentLog`, **rethrows** on failure — the service crashes and Windows Service recovery retries with the configured backoff, rather than ever falling back to production. Confirmed empirically this round: a fresh install with no `--mode`/`--server` in its `binPath` logs `mode=Production, endpoint=https://tablecore.net` at startup and opens **zero** TCP connections while unpaired.
- `SetupForm.cs`: resolves on construction; on failure, shows the error in the status line and **disables pairing entirely** rather than silently using any default.

**Automated tests (`SelfTests.cs`, 12 new, all passing)** proving exactly
the 6 required properties: production mode selects the production URL by
default; test mode requires an explicit override; a malformed/empty test
override fails closed; test mode cannot silently target `tablecore.net`;
production mode does not accidentally consume a non-production `--server`;
and `DescribeForLog()` never resembles a credential/bearer token (regex- and
substring-asserted).

**Operational discipline going forward** (the procedural half of
requirement 10): every acceptance-testing step in this round that needed a
non-default endpoint used `--mode test --server <url>` explicitly and
verified the resulting log line before proceeding, rather than relying on
`sc config` to silently rewire an already-running service's `binPath`.

## Y. The brief unintended production connection — exact explanation

**What happened:** while iterating on Windows-service acceptance testing in
the prior round of this phase, I ran `sc config TableCorePrintAgent
binPath= "<exe> --server http://127.0.0.1:3101"` (elevated, via a PowerShell
script) intending to point the *already-installed* service at a disposable
local test server, then restarted it. The `sc config` command's argument
quoting did not take effect the way intended — `sc qc` afterward showed
`BINARY_PATH_NAME` with **no** arguments at all, meaning the change silently
failed to apply.

**Why it reached production:** at that time, the agent's only
server-selection logic was "use `--server` if present in argv, else default
to `https://tablecore.net`." Since the `sc config` change hadn't actually
taken effect, the service's argv had no `--server` at all, so it fell
through to that default — connecting to the real `tablecore.net` (confirmed
via DNS resolution matching the observed remote IP and an active
`Get-NetTCPConnection` entry from the service's own process).

**Why it could not affect production data:** the credential the service
held at that moment existed *only* in a disposable local test Postgres
database created and destroyed by a throwaway script in this session — it
was never registered in the real Development or Production database.
Production's `requireWorkstationAuth` looks up the credential by its SHA-256
hash and returns a generic 401 for any hash it does not recognize (the same
code path used for a genuinely revoked/nonexistent credential — see
`packages/auth/workstation-auth.ts`). The heartbeat/poll requests that went
out therefore could only have produced a handful of rejected/unauthorized
responses in production's own request logs; no row in any production table
was read, created, or modified, because the request never got far enough to
reach a real workstation record.

**Detection and response:** noticed within roughly a minute (checking
`Get-NetTCPConnection` for the service's PID as part of verifying the `sc
config` change, expecting to see the local test server's port and instead
seeing a real external IP). The service was stopped immediately, and the
rest of that round's testing switched to the safer, already-proven
foreground CLI path (`--run --server <url>`) instead of mutating the
running service's configuration. The user was told about this directly and
in full, in the same turn it was found — not held back or minimized. The
structural fix in section X is designed specifically so this exact failure
mode — a configuration change that silently doesn't apply, defaulting to
production with no explicit signal — is no longer possible: a service whose
`--mode test` configuration fails to apply now fails to *start* at all,
loudly, rather than quietly talking to production.

---

**No push. No deploy. Stopping here for review, as instructed.**
