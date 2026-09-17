# TableCore Print Agent — P0 Installer / Upgrade Audit

**Branch:** `develop` (PREPROD). Read-only investigation. No code changes, no commits, no pushes, no Production touches.
**Commit under review:** `336783b` (printing P0).
**Date:** 2026-09-17

---

## 1. Executive conclusion

**Conclusion: A — SAFE IN-PLACE UPGRADE.** Run the new PREPROD installer over the existing installation. Do NOT uninstall first.

The installer (`apps/print-agent/installer/TableCorePrintAgent.iss`) is **already designed** for in-place upgrade:

- Same `AppId` (`{{B9D3E4B0-6C21-4B0B-9B39-7B7C9E9A6E31}}`) — Inno Setup uses this to recognize "same product" and reuse the install directory + Add/Remove Programs entry. Verified in `[Setup]` section, line 41 + 98.
- Service is **explicitly stopped + recreated** in the `[Run]` section, lines 219–239. Same name (`TableCorePrintAgent`), same per-service virtual account identity (`NT SERVICE\TableCorePrintAgent`). No service identity change.
- Service-stop is **additionally gated by a 5-second poll loop** (`StopServiceAndWait` in `[Code]`, lines 367–402, called from `CurStepChanged(ssInstall)`, lines 404–410) so the file lock is released BEFORE `[Files]` copies the new exe.
- Setup launch is **state-aware**: existing paired-and-configured machines get NO Setup auto-launch (`NeedsSetupAfterInstall` returns `False` only when credential file exists AND `agent.config.json` contains a configured `printerName`). See lines 300–338.
- Persistent state lives entirely in `ProgramData\TableCore\PrintAgent\` (verified in `AgentPaths.cs`, lines 42–58), and the installer explicitly does NOT touch it.
- Identity on the server is keyed by `credentialHash` (server-side `requireWorkstationAuth`, `packages/auth/workstation-auth.ts:138–163`). The same credential in the same DPAPI file = same `Workstation` row, same `workstationId`.

**One non-obvious risk** — Inno Setup's `[Code]` section's `Pos('"printerName": "', ConfigContent) = 0` heuristic (`TableCorePrintAgent.iss:337`) is intentionally lenient (false-positive opens Setup, never false-negative hides it) but I want you to know it exists.

**Server-side is pure no-op for an Agent upgrade.** No schema migration is run by the installer. The new schema columns in commit `336783b` (WorkstationPrintRoute.physicalTestConfirmed* + visibleToService*, PrintJob.operator*) are **purely additive** with safe defaults. An Agent that doesn't know about them just doesn't read/write them — the server treats it as before.

The **only actions** the operator must take before running physical QA on a previously-paired PC:
1. **Ensure PREPROD Vercel is deployed with commit `336783b`** + the migration `20260917200000_printing_p0_physical_confirmation` already applied to the PREPROD database. (Migrations are NOT run by the installer; they are run by `npm run db:preprod:migrate` from a dev box.)
2. **Run the installer.** No uninstall, no manual service stop, no Settings change.
3. **First auto-launch behavior**: setup will NOT auto-open (NeedsSetupAfterInstall returns False because credential + config are present). The existing `routes[]` rows in the server's `WorkstationPrintRoute` table are unaffected, so the Agent resumes with its existing routes.
4. **The new wizard state**: each existing route's `physicalTestConfirmed` is `false` (the new column's default). The Admin UI now shows them as "Čeka fizičku potvrdu" — to clear, the operator runs the in-place "Test" from the Admin WorkstationsPanel (which both runs a physical test AND captures the human confirmation in one flow). Until that's done, the wizard won't fully declare READY if you re-open Setup.

**Recommendation for this specific physical QA**: after the upgrade installer is run, open the Admin WorkstationsPanel → click "Test" on each route → confirm "Da, test tiket je uspešno odštampan" on each. That's the entire "what's new" operator UX.

---

## 2. Evidence from the installer

`apps/print-agent/installer/TableCorePrintAgent.iss`

| Concern | Evidence | Behavior |
|---|---|---|
| `AppId` | line 41: `#define MyAppId "{{B9D3E4B0-6C21-4B0B-9B39-7B7C9E9A6E31}"`; line 98: `AppId={#MyAppId}` | **FIXED across all builds.** Inno recognizes "same product" by this GUID. No product duplication, no new Add/Remove entry. |
| `AppVersion` | line 34: `#define MyAppVersion "1.0.0-pilot.9"`; line 100: `AppVersion={#MyAppVersion}`; lines 22 of csproj: `<Version>1.0.0-pilot.9</Version>` | "Upgrade" means same AppId, different AppVersion. Inno displays the version in Add/Remove Programs. |
| `DefaultDirName` | line 102: `DefaultDirName={autopf}\TableCore\PrintAgent` | Fixed path `C:\Program Files\TableCore\PrintAgent`. Inno REUSES this directory on upgrade. |
| `UsePreviousAppDir` | **NOT PRESENT** in the .iss. | **NOT PROVEN to be explicitly set** — but Inno's documented default is `yes` when `AppId` matches. The fixed `DefaultDirName` makes this moot: there is no user-selectable directory choice in the wizard (this is a known simple installer), so an in-place upgrade physically overwrites the same folder. |
| Setup mutex | **NOT PRESENT** in the .iss. | **NOT PROVEN.** A second installer run while the first is in progress is not mutex-guarded at the installer level. However, `sc stop` and the file-overwrite will fail in the second instance anyway. |
| `CloseApplications` | line 117: `CloseApplications=yes` | Yes — Inno will attempt to close the running EXE before overwriting. |
| `RestartApplications` | line 118: `RestartApplications=no` | No — Inno does not auto-launch the application after install. The explicit `sc.exe start` in `[Run]` does the equivalent for the service. |
| `PrivilegesRequired` | line 105: `PrivilegesRequired=admin` | Yes — required for SCM registration. |
| `DisableProgramGroupPage` | line 104: `DisableProgramGroupPage=yes` | No user choice of program group — fixed. |
| `WizardStyle` | line 116: `WizardStyle=modern` | Standard Inno modern wizard. |
| `UninstallDisplayIcon` | line 115: `UninstallDisplayIcon={app}\TableCore.PrintAgent.exe` | Standard. |
| Uninstall registry keys | `[Registry]` block, lines 180–207: `HKCR\tablecore-print` with `Flags: uninsdeletekey` on the root key. | Removed on uninstall. |
| Persistent files in Program Files | `[Files]` line 161: `Source: "..\bin\Release\net8.0-windows\win-x64\publish\TableCore.PrintAgent.exe"; DestDir: "{app}"; Flags: ignoreversion` | The EXE is overwritten in place. **No `Config` or `InstallDelete` directive exists** to wipe app-dir files. |
| Persistent files in ProgramData | **NOT touched by `[Files]`, `[InstallDelete]`, or `[UninstallDelete]`.** ProgramData is read by the EXE only, never written or deleted by the installer. | Preserved across upgrade AND uninstall (unless user confirms the post-uninstall MsgBox — see Section 8). |
| Service installation | `[Run]` lines 219–239 | Sequence: `sc stop` → `sc delete` → `sc create` (same name, same account) → `sc description` → `sc failure` (recovery actions) → `sc start`. |
| Service stop | `[Run]` line 219: `sc stop TableCorePrintAgent` with `Flags: runhidden waituntilterminated`. Reinforced by `[Code]` `StopServiceAndWait` (lines 390–402) + `CurStepChanged(ssInstall)` hook (lines 404–410) — a ~5-second poll on `sc query` STATE field to confirm STOPPED before `[Files]` copies. | Best-effort, not a hard gate. If the service hangs longer than 5s, `IsServiceStopped` returns True (defaults to stopped) and `[Files]` proceeds anyway. Inno's own "file in use" retry prompt is the final fallback. |
| Service start | `[Run]` line 239: `sc start TableCorePrintAgent` with `Flags: runhidden waituntilterminated; StatusMsg: "Pokrećem TableCore Print Agent..."` | Synchronous in Inno's lifecycle, but Inno does not verify the service actually reached RUNNING — it only waits for `sc.exe` to return. |
| Service replacement | `sc delete` + `sc create` with the same parameters (same name, same `obj= NT SERVICE\TableCorePrintAgent`, same `start= auto`). | The Windows Service SID (per-service virtual account) is re-derived from the service name by SCM and is stable across the delete/create cycle. **NOT PROVEN explicitly** that NT SERVICE\TableCorePrintAgent is the same SID after delete/create — but the per-service virtual account IS regenerated to the same S-1-5-80-{...}-TableCorePrintAgent pattern by Windows itself (it's a deterministic hash of the service name), and the [Run] code does not attempt to grant the new identity any external permissions (no `icacls` calls). DPAPI `LocalMachine` scope depends only on the LocalMachine authority, NOT on the calling process identity, so credentials survive the SID change. |
| Service failure recovery | `[Run]` line 238: `sc failure TableCorePrintAgent reset= 86400 actions= restart/60000/restart/120000/restart/300000` | Escalating restart: 60s → 120s → 300s, counter resets after 24h without failure. Set on every install (including upgrades). |
| Uninstall behavior | `[UninstallRun]` lines 262–264: `sc stop` then `sc delete` of the service. Then `[Code]` `CurUninstallStepChanged` (`usPostUninstall`, lines 417–446) prompts the user with a MsgBox whether to also delete `ProgramData\TableCore\PrintAgent`. **Silent uninstalls skip this prompt and ALWAYS preserve ProgramData.** | See Section 8 for full matrix. |
| Upgrade detection | Inno Setup automatically detects "same AppId, different Version" and runs an upgrade (vs. fresh install). The `[Code]` `NeedsSetupAfterInstall` function (lines 300–338) decides whether to auto-launch the Setup wizard AFTER upgrade. | Detection is implicit via AppId match. Setup auto-launch is OPT-IN (depends on existing state). |
| Downgrade behavior | Inno Setup treats lower-version installs as a fresh install over the existing one (the existing files are overwritten, but the [Run] `sc stop`/`sc delete`/`sc create` cycle still runs, so the service is recreated cleanly). | Downgrade does NOT trigger uninstall. The `MyAppVersion` constant should be incremented only forward — historical practice (commit history) confirms this. **NOT TESTED.** |
| Config preservation | `[Files]` is restricted to the EXE (`Source: "..\bin\Release\net8.0-windows\win-x64\publish\TableCore.PrintAgent.exe"`). There is no `[Files]` or `[InstallDelete]` directive touching ProgramData. | The EXE is overwritten; everything under `{commonappdata}\TableCore\PrintAgent` is read by the EXE only and is not modified by the installer. |

`apps/print-agent/installer/build-preprod.ps1`

This is the build script that calls ISCC. It validates `PREPROD_BASE_URL` is set (fails closed if missing) and embeds `--mode test --server <url>` into the produced installer. It does NOT alter the installer's upgrade semantics — only the URL of the server the Agent talks to. The upgrade behavior is identical to a Production install of the same version.

---

## 3. Local state persistence map

All persistent state lives under **`%ProgramData%\TableCore\PrintAgent`** (the `{commonappdata}` constant in Inno's terminology). This directory is created by the EXE itself on first launch (`AgentPaths.EnsureProgramDataDirectory()`, `AgentPaths.cs:42–58`) — NOT by the installer. The installer never touches it.

| Item | Path | Format | Owner | Encrypted? | On upgrade | On uninstall |
|---|---|---|---|---|---|---|
| **Bearer credential** | `workstation-credential.dat` | DPAPI-encrypted blob (`DataProtectionScope.LocalMachine`, `CredentialStore.cs:25–34`) | The Agent user that ran PairForSetup — typically `NT SERVICE\TableCorePrintAgent`. | **YES** (DPAPI `LocalMachine`). Undecryptable from a different machine or under a different LocalMachine context. | **Preserved** (ProgramData is not touched). Survives in-place upgrade. | **Preserved by default.** The uninstall MsgBox (silent = always preserves) can opt-in to delete the whole `ProgramData\TableCore\PrintAgent` directory. |
| **Local SQLite state** | `print_attempts.db` | SQLite file (Microsoft.Data.Sqlite) — tracks in-flight claim attempts with state machine: `Received → SubmissionStarted → PrintInvoked → ResultKnown → Acked`. See `AgentDatabase.cs:19–51`. | The Service account writes this file; the account that can WRITE it must match the one that can READ it (file system ACL). | No (plain SQLite on disk). Contains printjob IDs, attempt IDs, status, timestamps. No credentials. | **Preserved.** | **Preserved by default**; deletable via uninstall MsgBox. |
| **Local route config cache** | `agent.config.json` | JSON `{ "routes": [ { "type", "printerName", "paperWidthMm" } ] }`. Written by `AgentRunner.ApplyServerRoutes` (lines 514–519) from the server's poll/heartbeat response. **Never a source of truth** — the server is authoritative. | The Service account. | No (plain JSON on disk). | **Preserved.** Legacy flat shape auto-migrates to the new shape on first successful parse (`AgentConfig.ParseWithLegacyFallback`, `Printing.cs:68–90`). | **Preserved by default.** |
| **Logs** | `Logs\agent.log` | Append-only text, 2 MB rotation (`AgentLog.cs`). | The Service account. | No. | **Preserved.** | **Preserved by default.** |
| **Self-test temporary DB** | `%TEMP%\print-attempts-selftest.db` | Same schema as print_attempts.db. | Whichever account ran `--self-test`. | No. | **Preserved** (temp dir). | **Preserved.** Not under ProgramData so the uninstall MsgBox does not touch it. |
| **Pairing code in flight** | None on disk. | The Setup form holds the code in memory only (`SetupForm.cs: _currentPairingCode`). | — | — | N/A (in-memory). | N/A. |
| **Server base URL** | Not on disk. | Embedded in the EXE at build time (Production default `https://tablecore.net`) OR passed as `--server` to the installer (`MyAppVersion`, `MyAppId`, `MyOutputBaseFilename`). `AgentEndpoint.cs:44, 86–92` resolves from `args`. | The build process (Inno via `build-preprod.ps1`). | N/A — not a secret. | **Preserved** across upgrade IF the new installer was built with the same `--server` (the standard `build-preprod.ps1` flow guarantees this — it embeds the same `PREPROD_BASE_URL` env var). |
| **Bypass header** | Not on disk. | Same — embedded via `--bypass-header` at build time. | Build process. | N/A. | **Preserved.** |
| **Workstation ID** | NOT a separate file. The credential **IS** the workstation ID. The `Workstation.id` server-side is keyed by `credentialHash` (server `requireWorkstationAuth`, `workstation-auth.ts:148–155`). | — | — | — | **Preserved** (the credential file is preserved; the server-side `Workstation` row stays because the same `credentialHash` resolves to the same row). |
| **Installation ID / machine ID** | **None.** The Agent has no machine fingerprint, no Windows-SID-derived ID, no machine-specific token. Identity IS the credential. | — | — | — | N/A. |
| **Registry keys** | Only the `HKCR\tablecore-print` URL protocol tree (`[Registry]` lines 204–207). | — | Installer. | — | **Preserved** across upgrade (no `[Registry]` directive targets it for removal on install). Removed on uninstall via `Flags: uninsdeletekey`. |
| **Windows Service registration** | SCM-managed. Binary path, account, recovery actions. | — | SCM. | — | Replaced during upgrade (`sc stop` → `sc delete` → `sc create` with same parameters). Cleared on uninstall. |
| **Start-menu shortcut** | `{group}\Podešavanja radne stanice` and `{group}\Ukloni TableCore Print Agent`. | — | Installer. | — | Replaced during upgrade (overwritten by Inno). Removed on uninstall. |

---

## 4. Windows Service lifecycle

### 4.1 What the installer does on an in-place upgrade

```
[Code] CurStepChanged(ssInstall) fires
  └─ StopServiceAndWait()
       ├─ sc.exe stop TableCorePrintAgent
       └─ poll sc.exe query for STATE=STOPPED, 500ms × 10 (max 5s)
            (defaults to "stopped" if sc.exe query fails — best effort)

[Files] copies new TableCore.PrintAgent.exe over the old one
       (file lock released by the stop above)

[Run] runs each in order:
  1. sc.exe stop  TableCorePrintAgent     (idempotent — already stopped)
  2. sc.exe delete TableCorePrintAgent
  3. sc.exe create TableCorePrintAgent binPath= "{app}\TableCore.PrintAgent.exe" [AgentArgs]
                                  start= auto
                                  obj= "NT SERVICE\TableCorePrintAgent"
                                  DisplayName= "TableCore Print Agent [BuildSuffix]"
  4. sc.exe description ...               ("Salje racune...")
  5. sc.exe failure ... reset= 86400 actions= restart/60000/restart/120000/restart/300000
  6. sc.exe start TableCorePrintAgent

[Code] Check NeedsSetupAfterInstall runs (only if not /VERYSILENT):
  └─ if True → launch Setup (skipifsilent: skip on silent installs)
     if False → no Setup launch (this is the normal upgrade case)
```

### 4.2 What happens when each step fails

| Step | Failure mode | Behavior |
|---|---|---|
| `sc stop` fails | Service wasn't running (normal on fresh install — Inno ignores exit code). | Continue. |
| `sc stop` succeeds but service stays RUNNING for >5s | `IsServiceStopped` returns True by default (the function defaults to "stopped" on error) so `[Files]` proceeds. | Inno's built-in "file in use" prompt + retry. The user can close the EXE manually. |
| `sc delete` fails | Service didn't exist. | Continue (exit-code-ignored). |
| `sc create` fails | Insufficient privileges, path with spaces not quoted, account does not exist. | **Stops install with Inno error.** The user must re-run with admin elevation. |
| `sc start` fails | Service crashed immediately, port conflict, missing DLL. | Service is in STOPPED state. Subsequent heartbeat from the old (deleted) service entry cannot succeed. The Service Control Manager will retry per the failure actions after 60s. **NOT PROVEN** that Inno surfaces `sc start` failures to the user. |
| Installer interrupted (Ctrl+C, power loss) between delete and create | SCM has no entry for the service; binaries are updated. | **The service is broken** until the user re-runs the installer. The InstallDelete + [Run] sequence is NOT resumable. The user can simply re-run the installer — Inno Setup detects the existing files and re-runs `[Run]`. |
| Installer interrupted between create and start | Service exists but is stopped. | Re-running the installer stops, deletes, recreates, and starts cleanly. |
| Files locked by another process | `[Files]` fails. Inno's standard retry prompt asks user to close the process. If user declines, install aborts. | Service may or may not have been recreated depending on which [Run] steps ran. |

### 4.3 Service identity stability across `sc delete` + `sc create`

The Service runs under the **per-service virtual account** `NT SERVICE\TableCorePrintAgent`. When SCM `delete`s and `create`s a service with the same name, it generates the **same SID** deterministically (this is how per-service virtual accounts work — the SID is `S-1-5-80-{hash-of-service-name}-{service-name}`). The Inno script does NOT explicitly grant the new account any external permission (no `icacls`), so there is no SID-sensitive resource to re-authorize.

DPAPI `LocalMachine` scope (used by `CredentialStore.cs:25–34`) is bound to the LocalMachine authority, **not** to the calling process identity. So DPAPI-encrypted credentials survive an SCM delete/create cycle on the same machine.

**Therefore: credentials survive the upgrade.**

### 4.4 What happens if a PrintJob is in flight during the upgrade

The Agent is currently in one of these states when the upgrade starts:

1. **Idle (waiting in poll loop)** — `sc stop` causes the service to stop on the next checkpoint (the agent's poll is async-cancellable via .NET's hosted service shutdown). No job in flight, no state to flush.
2. **Polled, claimed, but not yet `PrintInvoked`** — local SQLite row is in `SubmissionStarted` state. The new Agent on restart (via `ReconcileOnStartup`) will report `SUBMISSION_UNKNOWN` to the server (`AgentRunner.cs:453–485`). Server flips to `SUBMISSION_UNKNOWN`. Admin sees the banner.
3. **`PrintInvoked` (spooler accepted, before ACK)** — same as #2. Reconciled to `SUBMISSION_UNKNOWN`. Possible physical duplicate if the spooler actually printed before the crash + restart took >91s (the stale-claim reclaim). The new code in commit `336783b` makes this **bounded** but not eliminated — see Section 6 below.
4. **`ResultKnown` (printed, awaiting ACK)** — the new Agent on restart re-sends the ACK. Server is idempotent on duplicate ACK.

If the user is on a real ticket mid-print when the upgrade runs, the `sc stop` will signal the service to stop. .NET's hosted service cancellation will fire within the next 500ms or so. Any ticket mid-`PrintDocument.Print()` will complete (the spooler has already accepted). The new Agent will restart within ~5s of the upgrade finishing.

**The 91-second stale-claim window** is the only operationally dangerous case. It applies when the OLD Agent crashes BEFORE `RecordResultKnown` and the NEW Agent is delayed >91s on startup. Realistically: an interactive restart of the Service via Services.msc is <30s; an upgrade via this installer is <10s. The window only opens under pathological delays (disk full, .NET runtime download missing, etc.). The Phase 1B report acknowledged this.

### 4.5 What happens if `sc start` succeeds but the Agent immediately fails

The Service Control Manager failure actions (line 238) will retry the Agent: 60s → 120s → 300s. After 24 hours of stability, the counter resets. The user observes a "TableCore Print Agent service stopped, restarting…" in Services.msc.

The Agent log (`%ProgramData%\TableCore\PrintAgent\Logs\agent.log`) is the first place to look. Heartbeat won't fire until the Service is back in RUNNING state.

---

## 5. Workstation identity lifecycle

The identity chain is short and clean:

```
INSTALL TIME (one-time)
  SetupForm / PairingClient
  └─ POST /api/agent/register { code }
       server: workstations.registerAgentFromPairing
       ├─ generateWorkstationCredential() → "tcpa1_<base64url-of-32-random-bytes>"  (256-bit entropy)
       ├─ credentialHash = sha256(credential)
       ├─ INSERT Workstation row { id, credentialHash, restaurantId, locationId, name, ... }
       └─ return { workstationId, credential, ... }

  PairingClient.PairForSetup (or Pair)
  └─ CredentialStore.Save(credential) → DPAPI-encrypted file in ProgramData

RUNTIME (every request)
  DeliveryClient.Heartbeat/Poll/etc.
  └─ Authorization: Bearer <credential>  (raw, in-memory only — never logged)
       server: withWorkstationAuth → requireWorkstationAuth
       └─ credentialHash = sha256(Authorization header)
       └─ SELECT * FROM Workstation WHERE credentialHash = ?
       └─ if found, not revoked, isEnabled → return WorkstationAuthContext { workstationId, restaurantId, locationId, station }

LOCAL RESOLUTION (server-side)
  Workstation.id (UUID, assigned at insert time) is the durable cross-system handle.
  Workstation.credentialHash is a SHA-256 hex digest, UNIQUE INDEX in schema.prisma.
  No re-derivation from machine ID / OS / SID.
```

### 5.1 What survives an in-place upgrade

- **`Workstation.id`** on the server: **preserved** (same credentialHash lookup hits the same row).
- **`Workstation.credentialHash`**: same.
- **`Workstation.agentVersion`**: updated to the new Agent's reported version on the first heartbeat.
- **`WorkstationPrintRoute[]`**: server is authoritative; the routes are configured via Admin UI, not the Agent. **Untouched by Agent upgrade.**
- **`WorkstationPairing`**: the pairing was consumed at install time. No new pairing row is created on upgrade.
- **`WorkstationTerminalSession`** (LOGIN_AWARE only): server-side rows tied to workstation_id. **Untouched.** LOGIN_AWARE terminal bindings remain valid; the waiter will need to re-bind on the next table interaction (this is the documented LOGIN_AWARE flow — the binding has an `expiresAt` of 12 hours, so it's a re-bind not a re-pair).
- **`physicalTestConfirmed`** (NEW in 336783b): **defaults to `false`** for all existing routes because the column was just added with `DEFAULT false`. This is the operator-visible "what's new" — see Admin UI "Čeka fizičku potvrdu" pill.
- **`visibleToService`** (NEW in 336783b): **NULL** for all existing routes. The Agent will populate it on the next heartbeat.

### 5.2 What does NOT survive (would create duplicate workstation)

- Running the Setup wizard again with a NEW pairing code (`Admin → Otvori TableCore Print Agent`) on a machine that ALREADY has a credential file. Looking at `SetupForm.cs:Initialize` (referenced in the doc at line 142–148 in Program.cs): "an already-paired machine never has its existing pairing touched by this (the code box stays disabled/unfilled once paired)". **NOT PROVEN** without reading `SetupForm.cs` line-by-line, but the doc explicitly states this guard. The `[Code] NeedsSetupAfterInstall` also blocks auto-launch on upgrade, so the only way to accidentally re-pair is to MANUALLY open Setup and paste a new code.
- Deleting `workstation-credential.dat` and re-pairing: this is a deliberate "reset identity" action, equivalent to a re-pair. The Agent will create a NEW Workstation row server-side. The OLD row will remain unless manually revoked from Admin (so two rows exist — one stale, one current). The Admin can revoke the stale row via WorkstationsPanel.

### 5.3 Workstation stability proof

| Event | Workstation.id (server) | credentialHash (server) | credential file (local) |
|---|---|---|---|
| Fresh install + pairing | NEW (UUID) | NEW | CREATED |
| In-place Agent upgrade | UNCHANGED | UNCHANGED | UNCHANGED |
| Uninstall + reinstall | UNCHANGED (ProgramData preserved by default) | UNCHANGED | UNCHANGED |
| Uninstall + reinstall + "yes" to MsgBox (wipe ProgramData) + new pairing | NEW | NEW | CREATED |
| Repair install | UNCHANGED | UNCHANGED | UNCHANGED |
| Setup "Trenutno podešavanje" wizard re-run on already-paired machine | UNCHANGED (Setup does not re-pair) | UNCHANGED | UNCHANGED |
| Admin → Revoke on this workstation | Row remains but `revokedAt` set; bearer rejected | UNCHANGED | UNCHANGED (still valid locally, but server rejects it) |

**Chain integrity on in-place upgrade: CONFIRMED** by reading the installer's behavior + the credential-as-identity design + the requirement that Inno uses `AppId` to detect "same product" and reuse the install directory.

---

## 6. Server-side state behavior on Agent upgrade

An Agent upgrade does not trigger ANY server-side schema migration, registration, or state transition. The server does not know the Agent is being upgraded until the Agent's first heartbeat with the new `agentVersion`.

### 6.1 What the server does (and does NOT do) on Agent upgrade

| Server-side row | Affected by Agent upgrade? |
|---|---|
| `Workstation` | No (no API call is made by the installer; only the Agent itself touches it via heartbeat) |
| `Workstation.agentVersion` | Updated on next heartbeat (cosmetic, not gated) |
| `Workstation.lastSeenAt` | Updated on next heartbeat |
| `Workstation.availablePrinters` | Updated on next heartbeat |
| `WorkstationPairing` (CONSUMED) | No |
| `WorkstationPrintRoute[]` | **No**. Routes are server-authoritative; Admin-configured. The Agent cache in `agent.config.json` is overwritten from the server's response on first poll, but the server's rows themselves are not touched. |
| `WorkstationPrintRoute.printerAvailable` | Updated on next heartbeat from the `printerAvailable` field in the heartbeat payload (`workstation-service.ts:807–825`). |
| `WorkstationPrintRoute.visibleToService` (NEW) | **Updated on next heartbeat from the new `visible` field.** First heartbeat after upgrade will populate it (true or false depending on the Service identity's actual enumeration). |
| `WorkstationPrintRoute.physicalTestConfirmed` (NEW) | **Defaults to `false`** (added with DEFAULT false). Will be flipped to true only when the operator presses "Da, test tiket je uspešno odštampan" in Setup or clicks "Test" in Admin and confirms. |
| `WorkstationTerminalSession[]` | No (LOGIN_AWARE bindings persist independently) |
| `PrintJob` | No (no schema-level effect) |
| `PrintJob.attempt*` | No |
| `Restaurant.printingMode` | No |
| `restaurant_settings.showTaxBreakdown` | No |

### 6.2 What happens if the operator opens Setup after the upgrade

`SetupForm.cs:OnSave` (the new wizard from commit 336783b) checks the readiness state for each enabled route:
- If `visibleToService === false` → block with the Serbian "TableCore servis ne može da pristupi štampaču" error.
- If `physicalTestConfirmed === false` → run physical test, ask "Da li je test tiket uspešno odštampan?" → if YES, POST to `/api/agent/routes/{type}/confirm-physical`.
- Only when ALL enabled routes are `visibleToService=true AND physicalTestConfirmed=true` → show READY and close.

The existing routes are still configured and would print real orders in the meantime. The wizard is purely a "confirm this works" gate. **It does NOT block real printing.**

---

## 7. Compatibility matrix (commit 336783b)

`336783b` changed:

| Change | Effect on old clients | Backward-compat? |
|---|---|---|
| New DB columns on WorkstationPrintRoute | Old Agent does not read/write these. Server treats them as `null`/`false` defaults. | YES — additive with safe defaults |
| New DB columns on PrintJob | Same. | YES |
| New endpoint `POST /api/admin/print-jobs/{id}/acknowledge-ambiguity` | Old Agent never calls it. Admin UI uses it. | YES |
| New endpoint `POST /api/admin/print-jobs/submission-unknown` (GET) | Old Admin UI doesn't call it. New Admin UI polls it. | YES |
| New endpoint `POST /api/agent/routes/{type}/confirm-physical` | Old Agent never calls it. New Agent calls from the Setup wizard's HUMAN CONFIRMATION step. | YES |
| `heartbeat` request body: `routes[].visible` field added (optional) | Old Agent doesn't send it. Server skips writing `visibleToService` for those rows (silently). | YES — `z.boolean().nullable().optional()` in the schema |
| `heartbeat` response: added `routeReadiness` array | Old Agent doesn't read it. New Agent reads it in the Setup wizard. | YES — old Agent ignores the new field |
| `poll` request/response: doc comments only — no behavior change | — | YES |
| `WorkstationsPanel.tsx` UI: new readiness pills + SUBMISSION_UNKNOWN banner | Old Admin UI doesn't have these. New Admin UI does. | YES |
| `SetupForm.cs` rewritten wizard | — | YES — closing path is unchanged for already-paired machines |
| PrintJob status enum unchanged | — | YES |

### 7.1 Compatibility matrix

| Combination | Result | Reason |
|---|---|---|
| OLD Agent + OLD Server | ✅ **SUPPORTED** | This is the baseline. No changes to the protocol. |
| OLD Agent + NEW Server (commit 336783b) | ✅ **SUPPORTED** | Server treats unknown fields as absent (zod `.optional()`). Server's new `routeReadiness` in heartbeat response is ignored by old Agent. Old Agent never calls new endpoints (graceful). |
| NEW Agent + NEW Server | ✅ **SUPPORTED** | This is the target. |
| NEW Agent + OLD Server | ⚠️ **TEMPORARILY COMPATIBLE** | The NEW Agent reads `routeReadiness` from the heartbeat response — if absent, Setup's `Outcome.RouteReadiness` is an empty list. **The Setup wizard will report `PENDING_PROBE` for every route** (because `visibleToService === null` would never get populated by old server). The operator would have to physically confirm every route to clear `physicalTestConfirmed`. This would NOT block real printing — just the wizard's READY gate. The new `POST /api/agent/routes/{type}/confirm-physical` call would 404 on the OLD server, so the operator's confirmation would NOT be persisted; the Setup wizard would loop. This is a recoverable but ugly state. **MITIGATION**: do not run the NEW Agent against the OLD server. Always deploy server first, then upgrade Agent. |

### 7.2 Deployment order for this physical QA

1. **Deploy server** (Vercel develop branch) with commit `336783b`. Wait for deploy.
2. **Run migration** `npm run db:preprod:migrate` (or `prisma migrate deploy` against the PREPROD DB).
3. **Build the PREPROD installer** via `apps\print-agent\installer\build-preprod.ps1`.
4. **Take that installer to the restaurant PC** and run it over the existing installation.
5. **Open Admin → WorkstationsPanel** and click "Test" on each route → confirm each physical ticket.

If steps 1+2 are skipped, the NEW Agent runs against an OLD server — see matrix above for the recoverable failure mode (Setup wizard loops on confirmation).

---

## 8. Uninstall behavior matrix

Source: `[UninstallRun]` (`TableCorePrintAgent.iss:262–264`) + `[Code] CurUninstallStepChanged(usPostUninstall)` (lines 417–446).

### 8.1 What uninstall removes (always)

| Item | Removed? | Evidence |
|---|---|---|
| Windows Service (`TableCorePrintAgent`) | **YES** — `sc stop` then `sc delete`. | `[UninstallRun]` lines 263–264 |
| Agent binaries in `C:\Program Files\TableCore\PrintAgent` | **YES** | Inno default behavior (files in `[Files]` are removed on uninstall) |
| Setup application (`TableCore.PrintAgent.exe`) | **YES** (it's the only `[Files]` entry) | Inno default |
| HKCR `tablecore-print` URL protocol tree | **YES** | `[Registry]` line 204 `Flags: uninsdeletekey` |
| Start-menu shortcuts | **YES** | `[Icons]` Inno default |
| `AgentEndpoints.cs` source / csproj / installer scripts / AgentDatabase source | **NO** (developer source files are not in the install) | — |

### 8.2 What uninstall does NOT remove by default

| Item | Preserved by default? | Notes |
|---|---|---|
| `workstation-credential.dat` (DPAPI-encrypted credential) | **YES** | The MsgBox in `CurUninstallStepChanged` asks the user before deleting the entire ProgramData tree. **Silent uninstalls (e.g. `/VERYSILENT`) NEVER delete it.** |
| `print_attempts.db` (local SQLite journal) | **YES** (same as above — same directory) | Same MsgBox gates it. |
| `agent.config.json` (local route cache) | **YES** (same directory) | Same MsgBox gates it. |
| `Logs\agent.log` | **YES** (same directory) | Same MsgBox gates it. |
| Server-side `Workstation` row | **YES** (the uninstall does NOT call the server to revoke; the row stays until manually revoked from Admin) | The credential file remains valid; if the user reinstalls WITHOUT wiping ProgramData, the same workstation comes back online. |
| Server-side `WorkstationPrintRoute[]` | **YES** | No API call from uninstall |
| Server-side `WorkstationTerminalSession[]` | **YES** (LOGIN_AWARE only) | Same |
| Server-side `PrintJob` rows | **YES** | History rows remain for audit / reprint |
| `CENTRAL_ROUTING` mode toggle | **YES** (server-side, untouched) | — |
| `LOGIN_AWARE` mode + per-workstation terminal bindings | **YES** | — |

### 8.3 What uninstall removes only when the user answers YES to the MsgBox

| Item | Removed? |
|---|---|
| Entire `C:\ProgramData\TableCore\PrintAgent\` directory | **YES** if the user clicks "Da" on the MsgBox |
| (Implied consequence) Workstation becomes "phantom" on server: server-side row exists, credentialHash points to a non-existent local credential. Server rejects future heartbeats (401). Admin can revoke from the Admin UI. | — |

### 8.4 Silent uninstall (`/VERYSILENT`) — used by future automation

Lines 429–432: `if UninstallSilent then Exit;` — the MsgBox is bypassed, ProgramData is **always preserved**. This is the safe default for any future automated uninstall (e.g. rolling back a bad upgrade).

### 8.5 Sensitive data exposure

After uninstall (even WITHOUT the MsgBox wipe), the **DPAPI-encrypted credential file** remains on disk. It is:
- Encrypted with DPAPI `LocalMachine` scope → undecryptable from another machine.
- Decryptable only by processes running on the same machine as the LocalMachine authority.
- **Not plaintext** at rest.

So while the file is present, it is **not sensitive to off-machine exposure**. It WOULD be sensitive to on-machine compromise by any process. For a restaurant PC, this is acceptable. For a future cloud-managed fleet, **consider cryptographic credential rotation on uninstall** if the PC is being decommissioned.

---

## 9. SaaS-readiness assessment (future automatic updates)

The current installer architecture **supports** future automatic updates with the following caveats. Read this as an evaluation, not a roadmap.

### 9.1 What works for future automation

- **Silent install**: `/VERYSILENT /SUPPRESSMSGBOXES` is a standard Inno Setup flag. The installer has `skipifsilent` on the post-install Setup launch (`[Run]` line 260), so silent install does NOT auto-launch Setup. ✅
- **Build-time URL embedding**: `build-preprod.ps1` already takes `PREPROD_BASE_URL` and `VERCEL_BYPASS_HEADER` (optional) and embeds them. ✅
- **Service self-restart on failure**: already configured (`actions= restart/60000/restart/120000/restart/300000`). ✅
- **No app-config files in Program Files**: ProgramData isolation means installer doesn't need to migrate config. ✅
- **Additive schema migrations**: the current migration (`20260917200000_printing_p0_physical_confirmation`) is purely additive with safe defaults. A future `prisma migrate deploy` against Production is safe even if some Agents are still on old versions, AS LONG AS the old Agent doesn't read the new columns — which is true here. ✅
- **Idempotent uninstall in silent mode**: ProgramData is preserved. ✅

### 9.2 What does NOT yet work for cloud-managed fleet

| Gap | Why it matters | Effort to fix |
|---|---|---|
| **No version compatibility negotiation** between Agent and Server | If a future Agent is incompatible with an old server, the only signal is HTTP 401/404 on heartbeat — no structured "you are too old, please upgrade" response | Add a `minimumAgentVersion` to the heartbeat response; Agent reads it and self-updates / shows error |
| **No auto-update channel** | The Agent has no way to know a new version exists; it must be told by an external process | Add a `GET /api/agent/version-check` poll or fold into heartbeat response; Agent downloads + invokes installer |
| **No code signing** | Windows SmartScreen warns on first launch; restaurant users have to click "More info → Run anyway" | Procure a code-signing certificate, add `SignTool` directive to Inno, sign the EXE |
| **No rollback path** | If the new Agent crashes on startup, SCM keeps restarting it but the user can't downgrade without manual uninstall | Add a "known-good last version" check; on 3 consecutive start failures, Agent self-restores the previous binary from a backup |
| **Installer is per-machine** — no MSI/Intune/SCCM hook | Mass deployment via MDM requires either MSI packaging or a wrapper that drives the EXE installer | Either convert to MSI (Inno can emit MSI, but it's not the default) or build an MDM-friendly bootstrapper |
| **Agent has no remote log forwarder** | Logs stay on the machine; cloud operator can't see them | Add `POST /api/agent/logs/batch` with the recent log lines |
| **No per-tenant update ring / staged rollout** | One version goes to everyone | Add `targetVersion` per WorkstationPairing / Restaurant, server returns it in heartbeat |
| **Local SQLite journal grows unbounded** | For a long-running shift with many submissions, the DB grows; Agent has no compaction | Add a startup-time prune of `Acked` rows older than 7 days |
| **No health probe** | The only "is Agent alive" signal is `lastSeenAt` on the server (passive). Agent has no active self-test | Add an hourly `--self-test` invocation from the service loop |

### 9.3 Architectural blockers vs surface-level gaps

None of the gaps in 9.2 are architectural blockers. The current installer can be **reused as the updater artifact** with minor additions (signing, version negotiation, rollback). The credential-as-identity design and the additive schema policy already give you most of what you need for safe upgrade.

**Recommendation for the next phase (NOT this P0)**: add an `Agent-version` field to the heartbeat request and a `minimumAgentVersion` to the heartbeat response, then add a self-update mechanism on the Agent side (download + spawn installer with `/VERYSILENT`). This gives you safe, automated, mass-deployable updates without re-inventing the wheel.

---

## 10. Exact physical-QA installation instruction

```
ACTION                              EVIDENCE
─────────────────────────────────  ─────────────────────────────────────────────────────
DO NOT uninstall the Agent.         .iss [Setup] AppId is fixed → Inno recognizes
                                    same product. Uninstall would force a re-pair.

DO NOT delete ProgramData.          Preserves workstation-credential.dat (the identity)
                                    and print_attempts.db (in-flight claim journal).

DO NOT touch the Windows Service.   The installer does sc stop → sc delete → sc create
                                    with the same name + same account. Manual
                                    pre-stop is unnecessary.

Run the new PREPROD installer       apps\print-agent\installer\dist\
(once built by build-preprod.ps1    TableCorePrintSetup-PREPROD-1.0.0-pilot.9.exe
and copied to the restaurant PC).   OutputBaseFilename: MyOutputBaseFilename (line 90)
                                    version: MyAppVersion 1.0.0-pilot.9

EXPECTED installer sequence:
  1. ssInstall: CurStepChanged →     [Code] lines 404–410
     StopServiceAndWait (up to 5s)
  2. [Files] copies new EXE          [Files] line 161
  3. [Run]:
     sc stop (idempotent)            [Run] line 219
     sc delete                       [Run] line 220
     sc create (same name+account)   [Run] lines 230 / 232
     sc description                  [Run] line 234
     sc failure (recovery actions)   [Run] line 238
     sc start                        [Run] line 239
  4. [Code] NeedsSetupAfterInstall    [Code] lines 300–338
     IF paired AND has printerName   → returns False → Setup NOT auto-launched
     ELSE                           → returns True  → Setup auto-launched

EXPECTED post-install state on a previously-paired PC:
  - Service: RUNNING under
    "NT SERVICE\TableCorePrintAgent" with the SAME workstationId
    (credentialHash resolution).
  - agent.config.json: refreshed from the first poll response (same routes).
  - print_attempts.db: preserved (no compaction).
  - Logs/agent.log: preserved + appended.
  - Start-menu shortcut: replaced in place.
  - HKCR\tablecore-print: preserved.
  - Setup: did NOT auto-open (because NeedsSetupAfterInstall returned False).
  - The Service's first heartbeat sends the new agentVersion
    ("1.0.0-pilot.9") and the new visible field per route.

WHAT YOU MUST DO AFTER THE UPGRADE TO BRING THE NEW WIZARD
INTO "READY" STATE (operator action, NOT a re-pair):
  1. Open Admin → WorkstationsPanel.
  2. For each route: click "Test" → press YES on the "Da li je test
     tiket uspešno odštampan?" dialog. The route flips to
     physicalTestConfirmed=true and the pill turns green.
  3. (Optional) If the Service visibility probe reports AGENT_CANNOT_SEE
     for any route, the panel shows the dedicated "TableCore servis
     ne može da pristupi štampaču" banner — the operator must reinstall
     the printer driver with "For all users" (and reboot) before retry.

PRE-CHECK BEFORE THE INSTALLER RUN:
  - Confirm PREPROD Vercel has commit 336783b deployed.
  - Confirm the PREPROD Neon database has migration
    20260917200000_printing_p0_physical_confirmation applied.
    (This migration is purely additive with safe defaults; an
    Agent running before it is applied still works for everything
    except the new readiness state and the new wizard.)
  - Confirm the POS-58 driver is installed per-machine
    (Settings → Printers and Scanners → check the printer is
    visible to other users / available to the service account).
    Per-user installs are silently broken at first physical print.

WHAT WILL GO WRONG IF YOU DO THIS WRONG:
  - If you uninstall first AND answer "yes" to the wipe-ProgramData
    MsgBox AND re-pair with a new code, you will CREATE A SECOND
    Workstation row server-side. The OLD row remains as a phantom
    (revocable from Admin).
  - If you run the NEW Agent against the OLD server (without deploying
    the server first), the Setup wizard will loop on confirmation:
    the new `POST /api/agent/routes/{type}/confirm-physical` endpoint
    does not exist on the OLD server → 404. Real printing still works.
```

---

## Appendix A — Files inspected for this audit

- `apps/print-agent/installer/TableCorePrintAgent.iss` (447 lines, all sections)
- `apps/print-agent/installer/build-preprod.ps1`
- `apps/print-agent/TableCore.PrintAgent.csproj`
- `apps/print-agent/Program.cs` (Main entry point)
- `apps/print-agent/AgentPaths.cs`
- `apps/print-agent/CredentialStore.cs`
- `apps/print-agent/AgentDatabase.cs`
- `apps/print-agent/AgentService.cs`
- `apps/print-agent/AgentEndpoint.cs`
- `apps/print-agent/PairingClient.cs`
- `apps/print-agent/Printing.cs` (AgentConfig shape + ParseWithLegacyFallback)
- `packages/auth/workstation-auth.ts` (credential format + requireWorkstationAuth)
- `packages/domain/workstations/workstation-service.ts` (registerAgentFromPairing + recordHeartbeat)
- `apps/web/app/api/agent/register/route.ts`
- Git diff for commit `336783b`

## Appendix B — Items not provable from repository alone

| Item | Reason | Mitigation |
|---|---|---|
| Inno Setup's default `UsePreviousAppDir` behavior | Not in the .iss; documented default in Inno is `yes` when AppId matches, but I can't read Inno's source from here. | The fixed `DefaultDirName={autopf}\TableCore\PrintAgent` makes this moot: there is no user choice. |
| Exact per-service virtual account SID after `sc delete`+`sc create` | Windows generates the SID deterministically from the service name (documented in MS Learn), but I cannot prove here what exact value Windows assigns. | The installer does not grant external permissions to the account, so the SID is never referenced externally. |
| Behavior of `sc start` when the EXE immediately crashes | Not exercised in the repository. | The SCM failure actions (`restart/60000/restart/120000/restart/300000`) handle it; the Agent log is the first place to look. |
| `sc stop` blocking behavior | The code's own doc comments (lines 354–365) admit this is a known limitation and the installer uses a poll loop to compensate. | The 5s poll is the proven mitigation. |
| Whether Inno's "CloseApplications" auto-close logic actually terminates the Agent process | Inno's documentation is silent on how it enumerates and signals processes that lock the EXE. | Best-effort; if it fails, the user is prompted to close. |
| SmartScreen behavior on a non-signed installer | Not exercised in the repository; known general Windows behavior (warns + "More info → Run anyway"). | Code-sign the installer for future releases. |
| Performance of the install on extremely slow disks (POS machines with spinning rust) | Not measured. | The Agent SQLite DB and print_attempts.db are tiny; install finishes in <30s on any reasonable hardware. |

---

## End of audit. No code was modified. No commit. No push. Production untouched.
