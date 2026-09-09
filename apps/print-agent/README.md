# TableCore Print Agent

Windows Service + installer that lets a restaurant's Kitchen/Bar thermal
printers receive tickets directly, without a browser tab having to stay
open. Current status: **approved for a controlled, supervised pilot at one
restaurant workstation.** Not yet approved for public/unattended
distribution — see [Public-release blockers](#public-release-blockers)
below.

For the full evidence-backed acceptance report (architecture decisions,
real hardware test results, validation numbers), see
[`../../docs/print-agent-phase2c-report-2026-09-09.md`](../../docs/print-agent-phase2c-report-2026-09-09.md).
This README is the operational reference; that report is the audit trail.

## Architecture

- **Windows Service** (`TableCorePrintAgent`), installed under
  `C:\Program Files\TableCore\PrintAgent\`, running as the per-service
  virtual account `NT SERVICE\TableCorePrintAgent` — not
  `NetworkService`/`LocalSystem`. This exact identity was chosen because it
  is the least-privileged account that actually works on this class of
  Windows configuration (see the report, section H, for why the built-in
  accounts failed).
- **On-demand WinForms Setup screen** — no persistent tray icon. Opened by
  double-clicking the installed EXE or the Start Menu shortcut "TableCore
  Print Agent Setup." Used only for initial pairing and rare
  reconfiguration.
- The service polls the TableCore server over outbound HTTPS only (no
  inbound ports, no dependency on a browser tab). It reuses the exact same
  claim/print/report state machine proven in earlier phases — durable local
  state in SQLite means a crash or reboot at any point never causes a
  double-print, and never silently drops a job.
- Self-contained, single-file win-x64 .NET 8 build — the target machine
  does not need .NET installed separately.

## Admin: adding a workstation

1. In the TableCore Admin panel, go to **Settings → Printers**. The
   "TableCore Print Agent — instalacija" panel shows a download link when
   one has been configured (see [Release distribution](#release-distribution)
   below); until then it honestly says the installer isn't published here
   yet — ask your TableCore contact for the file directly.
2. Click **+ Dodaj radnu stanicu**, choose Kitchen or Bar, optionally name
   it (e.g. "Kuhinjski računar"), and generate a pairing code. The code is
   shown **once**, valid for 15 minutes, format `XXXX-XXXX-XXXX`.
3. On the kitchen/bar PC: run `TableCorePrintSetup.exe`, following the
   installer prompts (administrator elevation is needed for install only —
   see [Windows Service behavior](#windows-service-behavior)). No
   PowerShell, no command line, no manual `.NET` install, no JSON editing.
4. After install, the Setup screen opens automatically (or launch it later
   from the Start Menu). Enter the pairing code, click **Poveži**. The
   screen shows "Povezano sa TableCore: `<name>` (`<station>`)" — it never
   shows the underlying credential.
5. Choose the exact Windows printer queue name, station, and paper width
   (58/80 mm), then **Sačuvaj**.
6. Back in Admin, use the workstation's **Test Print** button (see
   [Test Print](#test-print) below) to confirm before relying on it for
   real orders.

## Installation (what actually happens)

`TableCorePrintSetup.exe` (Inno Setup) requires one UAC elevation to:
install the self-contained binary to `C:\Program Files\TableCore\PrintAgent\`,
register the Windows Service (`sc create`, account
`NT SERVICE\TableCorePrintAgent`, `start=auto`), configure bounded service
recovery (restart after 60s, then 120s, then 300s — never a tight
crash-loop), and create Start Menu shortcuts. **The running service itself
needs no admin rights** — only the installer does.

## Windows Service behavior

- Starts automatically at boot, before any user logs in; survives
  logoff/login.
- **A freshly installed, unpaired service is not an error state.** It waits
  (polling every 30s) for pairing rather than crash-looping. Confirmed
  empirically: an unpaired service opens **zero** network connections — it
  does not talk to the server at all until a credential exists.
- Once paired, a genuine unexpected error terminates the process and lets
  the Windows Service Recovery policy (configured by the installer) restart
  it with escalating delays.
- Printer visibility does not depend on being logged in — the service
  enumerates installed printers under its own service account, independent
  of any interactive session.

## Printer selection

Set once via the Setup screen (station, exact Windows printer queue name,
paper width 58/80mm), stored in
`C:\ProgramData\TableCore\PrintAgent\agent.config.json`. The agent **never**
silently substitutes a different printer if the configured one is
unavailable — it reports the failure instead (visible in Admin as "Štampač
nije dostupan").

## Test Print

Admin → workstation row → **Test Print**. This is a fully authenticated
round trip through the real agent — not a bare local print call and not a
fake order:

1. Admin's click sets a flag on the `Workstation` row (`testPrintStatus=PENDING`) — no `PrintJob`, no `Order` row is created, so it never touches accounting or reporting.
2. The agent notices the flag on its next regular heartbeat (no separate polling needed) and prints locally through the same code path as a real ticket.
3. The printed ticket is explicitly marked **"TABLECORE TEST PRINT"** and includes the workstation name, station, printer, paper width, agent version, and a timestamp.
4. The agent reports success/failure back over the same authenticated channel; Admin shows "Test štampa uspela"/"nije uspela" with the reported error, if any.

## Auto Print ON/OFF

Auto Print is an existing, restaurant/location/station-level Admin setting
(`PrinterConfig.autoPrint`) — unrelated to whether the Print Agent itself is
installed. **The agent does not decide this.** With Auto Print OFF, the KDS
continues to work exactly as before (manual print actions, no automatic
Kitchen/Bar dispatch); turning it ON does not resurrect any backlog of
already-existing jobs. Installing the agent does not change this setting —
an admin must deliberately turn Auto Print on for a station once the agent
is verified working via Test Print.

## Logs and troubleshooting

Logs: `C:\ProgramData\TableCore\PrintAgent\logs\agent.log` (rotates to
`agent.log.1` at 2 MB). Contains: service start/stop, active server
endpoint (mode + host — see [Endpoint modes](#endpoint-modes)), printer
enumeration at every start, pairing-wait state, heartbeat/poll network
errors, job/attempt IDs, printer-unavailable warnings, submission outcomes,
startup reconciliation, Test Print requests/outcomes, and the agent
version. **Never logged**: the bearer credential, the pairing code, ticket
content, `AUTH_SECRET`, database URLs.

Common issues:
- **Service won't start after install**: check `agent.log` for an
  `AgentEndpointConfigurationException` message — this means the service
  was configured with an invalid `--mode`/`--server` combination (should
  never happen via the normal installer, which passes none). Reinstall.
- **Printer shows unavailable in Admin**: the exact configured printer name
  must match a Windows-installed queue on that machine — reopen the Setup
  screen and reselect it from the dropdown (never hand-edit
  `agent.config.json`).
- **Station appears offline in Admin**: check the service is running
  (`services.msc` → "TableCore Print Agent"); check `agent.log` for
  recent heartbeat errors.

## Uninstall / reinstall

Uninstalling **preserves** `C:\ProgramData\TableCore\PrintAgent\` (pairing
credential, configuration, delivery state, logs) **by default** —
deliberately, so a reinstall does not require re-pairing. The uninstaller
asks (interactively; a silent/`/VERYSILENT` uninstall always preserves,
never assumes deletion) whether to also permanently delete that data.
Program Files and the Windows Service registration are always removed.

## Revocation

Admin → workstation row → **Opozovi**. Immediate and irreversible — the
credential is permanently invalidated server-side (`revokedAt` set,
`isEnabled=false`). A revoked workstation must be **paired again from
scratch** (new pairing code); there is no "un-revoke."

## Endpoint modes

The agent talks to exactly one of two kinds of server, chosen explicitly —
never inferred or silently defaulted to a non-production server:

- **Production** (the only mode the installed product ever uses): always
  `https://tablecore.net`. This is the default with no configuration
  needed.
- **Test** (internal/development only, never used by the installer or a
  restaurant deployment): requires *both* `--mode test` and an explicit
  `--server <url>` that is not `tablecore.net`. Any incomplete or malformed
  test configuration fails immediately rather than silently falling back to
  production — see the report section X for why this exists and how it's
  tested (12 automated tests).

The Setup screen and `agent.log` always show which endpoint is active
(`mode=Production, endpoint=https://tablecore.net` or
`mode=Test, endpoint=http://...`) so this can always be visually confirmed.

## Windows OS support

- **Windows 10 x64**: acceptance-tested on real hardware, including the
  actual built installer, service auto-start, printer enumeration, pairing,
  heartbeat, Test Print, a controlled real Kitchen ticket, upgrade, and
  uninstall. See the report for exact evidence.
- **Windows 11 x64**: build target and installer configuration support it
  (`win-x64`, `x64compatible`), and nothing in the design is Windows 10-only
  — but **physical hardware acceptance is PENDING**. No Windows 11 hardware
  has been tested yet. Do not present Windows 11 as fully verified until
  that acceptance is completed.

## Code signing

The installer is currently **unsigned**. This is acceptable for the
controlled, supervised pilot (the installing admin clicks through one
SmartScreen warning), but **a real Authenticode code-signing certificate is
required before any public/unattended distribution** — see the report
section O for the exact process.

## Release distribution

Installer binaries are never stored in the database. Admin's download
button reads an optional `PRINT_AGENT_INSTALLER_URL` server environment
variable; when unset, it honestly reports "not published here yet" rather
than showing a broken or fabricated link. See
[Controlled pilot plan](../../docs/print-agent-phase2c-report-2026-09-09.md)
for how the pilot installer will actually be distributed.

## Public-release blockers

1. Authenticode code signing (section O of the report).
2. Real Windows 11 hardware acceptance.
3. A decision + configuration for public installer hosting (currently generates locally only).

## Developer reference

Everything below this line is for people working on the agent's source
code, not for restaurant staff or admins.

### Build and test

```powershell
cd apps/print-agent
dotnet build
dotnet run -- --self-test        # 60/60 checks, no printer required
dotnet publish -c Release        # self-contained win-x64 single-file
```

### CLI flags (internal/diagnostic use only — never used by end users)

- `--self-test` — run the C# self-test suite.
- `--list-printers` / `--probe-printer` — enumerate/preflight without printing.
- `--pair <CODE> [--mode test --server <url>]` — pair from the command line.
- `--heartbeat` — send one heartbeat and exit.
- `--run [--mode test --server <url>]` — run the real poll/claim/print loop in the foreground (same code the service runs).
- `--serve` — legacy Phase 1 loopback HTTP listener (see [HARDWARE-TEST.md](HARDWARE-TEST.md)); requires `TABLECORE_AGENT_TOKEN` and `agent.local.json`. Not part of the shipped product.
- No arguments (and not launched by the Service Control Manager) — opens the WinForms Setup screen.

`--mode test` always requires an explicit `--server <url>` that is not
`tablecore.net`; omitting `--mode` always means production, regardless of
any `--server` value that doesn't match the production host (see
[Endpoint modes](#endpoint-modes)).

### File layout

| What | Location | Notes |
| --- | --- | --- |
| Installed binary | `C:\Program Files\TableCore\PrintAgent\` | Never mutable state here |
| Config, credential, SQLite state, logs | `C:\ProgramData\TableCore\PrintAgent\` | Machine-shared, not per-user |
| Dev-only fallback config | `apps/print-agent/agent.local.json` (gitignored) | Only used by `dotnet run` from the source checkout |

### Installer

`installer/TableCorePrintAgent.iss` (Inno Setup 6). Build with:

```powershell
dotnet publish -c Release
& "<path to Inno Setup>\ISCC.exe" installer\TableCorePrintAgent.iss
```

Output: `installer/dist/TableCorePrintSetup.exe` (gitignored — never
commit the built binary).

### Related historical documents

- [AUDIT.md](AUDIT.md) — pre-agent architecture audit of the existing QZ/browser printing system.
- [PHASE2.md](PHASE2.md) — original Phase 2 design proposal (superseded on several points by what was actually built).
- [COMPATIBILITY.md](COMPATIBILITY.md) — Phase 1 Windows 10/11 API compatibility audit.
- [HARDWARE-TEST.md](HARDWARE-TEST.md) — legacy `--serve`-mode manual diagnostic procedure.
