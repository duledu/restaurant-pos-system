# Windows 10 / Windows 11 compatibility and deployment audit

> **Historical Phase 1 audit — since superseded on the key open question.**
> Item 9 below ("System.Drawing.Printing is not supported in Windows
> Services... prefer a per-user console/tray agent") was the right caution
> at the time, but Phase 2C's real hardware testing found this **does**
> work reliably when hosted via `BackgroundService` under the correct
> service identity (`NT SERVICE\TableCorePrintAgent`) with the binary
> installed to Program Files — see
> [../../docs/print-agent-phase2c-report-2026-09-09.md](../../docs/print-agent-phase2c-report-2026-09-09.md)
> section H for the empirical evidence. Windows 11 physical acceptance
> (item throughout this file) remains genuinely pending — no hardware was
> available in Phase 2C either.

Audited 2026-09-09. **Release requirement: one codebase and one x64 installer must support Windows 10 x64 and Windows 11 x64. No Windows 11-specific implementation or installer fork.** This is a product requirement, not a claim that physical acceptance or Microsoft vendor support has already been established on every Windows edition/build.

## Verdict and scope

No Windows 11-only API was found. The existing .NET 8 Windows desktop APIs, UTF-8 JSON, printer-driver path and localhost socket are technically applicable to both systems. The same `win-x64` output is the intended artifact for both. A read-only Win32_OperatingSystem query identified this execution host as **Microsoft Windows 10 Pro, 10.0.19045, 64-bit**. Packaged executable tests passed on that host; physical printing was not attempted. Windows 11 execution and kitchen hardware acceptance remain pending. Windows Server, ARM64 and 32-bit Windows are outside the declared x64 workstation release target.

Proposed initial qualification machines are Windows 10 22H2 x64, Windows 10 Enterprise LTSC 2021 x64 where deployed, and a currently serviced Windows 11 x64 release. Record exact edition/build, OS servicing status and driver version; do not label every historical Windows 10 build tested based on one machine.

Technical compatibility is separate from vendor support. Microsoft's current [.NET 8 supported OS matrix](https://github.com/dotnet/core/blob/main/release-notes/8.0/supported-os.md) lists Windows 10 LTSC variants and supported Windows 11 versions, but puts ordinary Windows 10 22H2 in its out-of-support list. Windows 10 22H2 general support ended October 14, 2025; see [Windows release information](https://learn.microsoft.com/en-us/windows/release-health/release-information). ESU availability must not be presented as proof of .NET vendor support. TableCore's Windows 10 release requirement remains; the exact support commitment needs a tested edition/build matrix and OS servicing policy.

## API and operational audit

| Requirement | Finding for both Windows versions |
| --- | --- |
| 1. Runtime / target framework | `net8.0-windows`, `UseWindowsForms=true`, .NET 8 SDK selected by global.json. No Windows 11 SDK contract or WinRT dependency. The TFM itself is not a guarantee of support for obsolete Windows releases. Use the x64 SDK for development and win-x64 for distribution. |
| 2. PrintDocument / APIs | PrintDocument, StandardPrintController, PrinterSettings, PaperSize, GDI+ Bitmap/Graphics/Arial and kernel32 GlobalFree are established Windows APIs, not Windows 11 additions. No Chrome, Electron, QZ or window.print. Important hosting limitation below. |
| 3. Spooler | Uses the installed Windows driver and spooler under the running account on both OSes. Spooler must be running; the account must have print permission. No queue/service changes are performed. Submission acknowledgement is not physical output. |
| 4. Enumeration | PrinterSettings.InstalledPrinters reports queues visible to the process identity. Same API on both; user-specific queues may not appear for a future service account. |
| 5. HTTP | Kestrel TCP listener at 127.0.0.1:17831; bearer protection, Host/origin checks and disabled endpoint overrides. No Windows 11 networking feature, HTTP.sys URL reservation, IIS installation or public firewall opening is needed. |
| 6. Config / storage | Phase 1 reads agent.local.json from the explicitly selected working directory; logs/test output are in its artifacts directory. Works in a user-writable checkout on both. Do not install mutable files in Program Files. Future installer: binaries in Program Files, per-user state in LocalAppData or shared state in ProgramData with explicit ACLs; resolve paths through Windows special folders. Auto-start must set a known working directory or use a later absolute config path. |
| 7. Serbian rendering | UTF-8 JSON becomes .NET Unicode strings; Graphics.DrawString with Arial renders č ć ž š đ and Č Ć Ž Š Đ into pixels. No OEM codepage or printer-resident character set. Font presence and driver output still require visual validation on both OSes. |
| 8. Thermal paper | Same 58/80 mm code, 48/72 mm printable content widths, measured raster height plus 4 mm feed. OS-independent layout, driver-dependent custom paper support. Graphics-capable x64 printer driver required; Generic/Text Only is unsuitable. Test each width and actual driver; no universal printer guarantee. |
| 9. Service / auto-start | Both OSes support services and logon tasks, but this PrintDocument code is not service-ready. Prefer a per-user console/tray agent launched by a logon task. Do not enable service mode by simply wrapping this executable. |
| 10. Installer | One x64 MSI or EXE can package the same self-contained folder for both. Avoid Windows 11-only launch conditions. Install drivers/pairing/admin settings separately from kitchen users' order flow. Installer, signatures, updates and rollback remain Phase 2. |

## Hosting limitation found by this audit

Microsoft explicitly states that [System.Drawing.Printing is not supported in Windows Services or ASP.NET applications/services](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.printing?view=windowsdesktop-8.0). This applies on **both Windows 10 and Windows 11**.

The current prototype invokes PrintDocument inside an ASP.NET Core/Kestrel host, albeit launched as a logged-in user's console process. Therefore it is a working-code POC, **not a Microsoft-supported production hosting configuration**. Running it interactively does not erase that documented limitation. This audit does not silently certify it or introduce a production service.

Before production, keep rendering/submission in a desktop-session worker and keep the HTTP/outbound delivery host separate, or select a supported native printing host/API architecture. Prefer the smallest desktop-worker separation that retains PrintDocument, the same layout and one installer on both OSes. A service broker is optional, not required just to get auto-start. Review IPC authentication, serialization, crash/unknown-result handling and worker ownership before making that change. This is a release gate independent of Windows 10 compatibility; no production TableCore flow was modified in this audit.

## Deployment choice

Use the `WindowsX64` publish profile: Release, `win-x64`, `SelfContained=true`, no trimming and no single-file bundling. A normal folder is simpler to inspect, sign, update and package in one MSI/EXE. There is no need for OS-specific RIDs or separate builds. The profile disables IIS web.config generation; this is a workstation executable.

```powershell
# Run from apps/print-agent with the .NET 8 x64 SDK:
dotnet publish .\TableCore.PrintAgent.csproj -c Release -r win-x64 --self-contained true -p:PublishProfile=WindowsX64 -o .\artifacts\win-x64
```

The output contains `TableCore.PrintAgent.exe` and its managed/native runtime dependencies. [Self-contained publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/) eliminates the restaurant's manual .NET installation; ship the **entire folder**, not just the EXE. Windows, fonts, a graphics-capable printer driver and the Windows Spooler remain prerequisites. A clean Windows VM without .NET is still required to verify installer-level prerequisites. No installer was created or deployed here.

Project packaging excludes artifacts, the private SDK and agent.local.json. Pair/configure the installed workstation later; do not distribute development tokens or workstation config. For local inspection only:

```powershell
Copy-Item .\agent.example.json .\artifacts\win-x64\agent.local.json
Push-Location .\artifacts\win-x64
.\TableCore.PrintAgent.exe --list-printers
.\TableCore.PrintAgent.exe --probe-printer
Pop-Location
```

Self-contained applications carry their runtime and must be republished/redistributed for runtime security updates. [.NET 8 support ends November 10, 2026](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/). Keep Phase 1 on the requested .NET 8; schedule a supported-runtime review before production releases beyond that date. Self-containment does not extend the runtime or OS lifecycle.

## Release validation matrix

Current evidence: Release self-contained publish succeeded with .NET 8 SDK 8.0.425 and bundled NETCore/WindowsDesktop/ASP.NET Core runtimes 8.0.31. The folder is approximately 184.8 MiB. On Windows 10 Pro x64 build 19045, the published EXE passed 20 self-tests and 19 API/package checks; the latter verifies the process loaded coreclr.dll from its own publish folder. POS-58 (1) enumeration and no-print geometry preflight passed. Workstation config, private SDK and prior artifacts were absent from the package. This verifies bundled-runtime use on a machine that also has .NET installed, not clean-machine installation or physical printing. The 43 existing print unit tests and 31 isolated-test-DB integration tests passed in the preceding Phase 1 acceptance run; no production-flow code changed during this compatibility audit.

Reproduce package tests without printing:

```powershell
.\artifacts\win-x64\TableCore.PrintAgent.exe --self-test
.\Test-Api.ps1 -AgentExecutable (Join-Path $PWD 'artifacts\win-x64\TableCore.PrintAgent.exe')
```

On both Windows 10 and Windows 11 x64: run the same PowerShell 5.1-compatible [hardware procedure](HARDWARE-TEST.md), with QZ closed, then test 58 mm and 80 mm devices, both stations, Unicode/bold/wrapping, duplicate IDs, offline queues, custom page rejection and shutdown/restart behavior. Also test the final installer on clean machines without a shared .NET runtime. Use the same package hash on both OSes. Installer start-at-logon, ACLs, repair/uninstall and service identity (if later used) are separate release checks.

No hardware-test command differs between Windows 10 and Windows 11. Use 64-bit Windows PowerShell 5.1 or PowerShell 7 on either. Do not use PowerShell 7-only syntax, winget availability, Windows 11 Settings paths or machine-name heuristics as prerequisites.
