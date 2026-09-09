# Windows 10 x64 and Windows 11 x64 / POS-58 (1) acceptance test

> **Historical/internal diagnostic procedure (Phase 1 `--serve` loopback
> mode only).** This exercises the legacy Kestrel loopback listener behind
> the explicit `--serve` CLI flag — useful for low-level printer/driver
> connectivity diagnosis, but it is **not** how the shipped product works.
> For the actual installer-based product (Windows Service, Admin pairing,
> authenticated delivery, Test Print), see [README.md](README.md) and
> [../../docs/print-agent-phase2c-report-2026-09-09.md](../../docs/print-agent-phase2c-report-2026-09-09.md).

Run these commands in **one PowerShell window** on the actual kitchen PC. Close QZ Tray manually first. The agent does not connect to QZ, Chrome or TableCore's server. No order/database data is used. The printer must be powered on, connected, loaded with 58 mm paper and installed as **POS-58 (1)** using a Windows graphics-capable driver.

**All commands are identical on Windows 10 and Windows 11.** Use 64-bit Windows PowerShell 5.1 (included with both) or PowerShell 7. No winget or Windows 11 Settings feature is required. Windows 10 is a release requirement, not yet a tested hardware result; see [compatibility and vendor-support qualifications](COMPATIBILITY.md).

## 1. Verify .NET 8, build and configure

Adjust only the repository directory if your checkout is elsewhere. Install the .NET 8 Windows x64 SDK first if `dotnet` is unavailable. The SDK includes the required desktop and ASP.NET Core runtimes.

```powershell
Set-Location '<repository-checkout>\apps\print-agent'   # e.g. C:\restaurant-pos-system\apps\print-agent
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
[Environment]::Is64BitProcess
$PSVersionTable.PSVersion
dotnet --list-sdks
dotnet --version
dotnet --list-runtimes
dotnet build .\TableCore.PrintAgent.csproj -c Debug
if ($LASTEXITCODE -ne 0) { throw 'Build failed; stop here.' }
Copy-Item .\agent.example.json .\agent.local.json
Get-Content .\agent.local.json
dotnet run --no-build -- --list-printers
dotnet run --no-build -- --probe-printer
```

Expected SDK version: `8.0.x` (global.json selects .NET 8). Expected config:

```json
{"station":"KITCHEN","printerName":"POS-58 (1)","paperWidthMm":58}
```

Preflight should return `PREFLIGHT_ONLY`; this does **not** print. If it reports failure, resolve the reported queue/geometry issue first. The sample requested page is roughly 58 × 73 mm, not A4/Letter.

## 2. Run the agent locally and verify health

This starts the console application in the background with logs. No service, auto-start entry or installer is registered. Keep this PowerShell window open: its variables hold the local token and test job ID. The token is random and is never saved in config.

```powershell
$tokenBytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($tokenBytes)
$rng.Dispose()
$env:TABLECORE_AGENT_TOKEN = [Convert]::ToBase64String($tokenBytes)
$headers = @{ Authorization = "Bearer $env:TABLECORE_AGENT_TOKEN" }
$base = 'http://127.0.0.1:17831'
New-Item -ItemType Directory -Force .\artifacts | Out-Null
$dotnetExe = (Get-Command dotnet).Source
$agentDll = Join-Path $PWD.Path 'bin\Debug\net8.0-windows\TableCore.PrintAgent.dll'
$agent = Start-Process -FilePath $dotnetExe -ArgumentList @("`"$agentDll`"") -WorkingDirectory $PWD.Path -WindowStyle Hidden -PassThru -RedirectStandardOutput '.\artifacts\agent.log' -RedirectStandardError '.\artifacts\agent-error.log'
$health = $null
for ($i = 0; $i -lt 40; $i++) {
    if ($agent.HasExited) { Get-Content .\artifacts\agent-error.log; throw 'Agent exited.' }
    try { $health = Invoke-RestMethod "$base/health" -Headers $headers; break } catch { Start-Sleep -Milliseconds 250 }
}
if ($null -eq $health) { throw 'Agent health unavailable. Inspect artifacts logs.' }
$health | ConvertTo-Json
```

Expected `/health`:

```json
{
  "status": "ready",
  "station": "KITCHEN",
  "paperWidthMm": 58,
  "printerName": "POS-58 (1)",
  "mode": "SILENT",
  "durable": false,
  "spoolerChecked": false
}
```

`ready` means the API is running. It does not mean the printer is online, loaded or physically printing. To run in the foreground instead, use `dotnet run --no-build` after setting the token and issue API requests from another terminal with the same token. Do not start a second instance on port 17831.

## 3. List printers and confirm the target

```powershell
$printers = Invoke-RestMethod "$base/printers" -Headers $headers
$printers | ConvertTo-Json -Depth 3
if ($printers.printers -cnotcontains 'POS-58 (1)') { throw 'POS-58 (1) is not installed for this Windows user.' }
'POS-58 (1) detected'
```

Expected response shape (other queue names vary):

```json
{"printers":["POS-58 (1)","POS-58"],"selectedPrinter":"POS-58 (1)"}
```

## 4. Submit exactly one test ticket

**This is the first step that can print paper.** Run once, then inspect the physical printer.

```powershell
$jobId = [guid]::NewGuid().ToString('D')
$testBody = @{ jobId = $jobId } | ConvertTo-Json -Compress
try {
    $result = Invoke-RestMethod "$base/test-print" -Method Post -Headers $headers -ContentType 'application/json' -Body $testBody
    $result | ConvertTo-Json -Depth 5
} catch {
    $_.Exception.Message
    $_.ErrorDetails.Message
}
# Fetch the authoritative local record, including after an HTTP error:
Invoke-RestMethod "$base/jobs/$jobId" -Headers $headers | ConvertTo-Json -Depth 5
```

The ticket contains TABLECORE, KUHINJA, STO 2, the two items, Napomena/BEZ LUKA, Test znakova, both `č ć ž š đ` and `Č Ć Ž Š Đ`, a separator and current Windows local time. Verify one compact ticket, legibility, bold headings, no clipped text, no extra page/long A4 feed, and no Chrome/QZ/confirmation dialog.

Submission success response:

```json
{
  "jobId": "<your UUID>",
  "fingerprint": "<content hash>",
  "outcome": {
    "status": "SUBMITTED_TO_SPOOLER",
    "guarantee": "PrintDocument.Print returned without error; no spool job ID or physical-paper acknowledgement is exposed.",
    "error": null
  }
}
```

This means the Windows submission call returned without an error, **not physically printed**. Hardware success requires you to observe the correct ticket coming out. An offline printer can retain accepted work in its Windows queue.

`ACCEPTED` means only in-memory acceptance. `FAILED_BEFORE_SUBMISSION` means no Print call occurred. `SUBMISSION_UNKNOWN` means an error after entering Print: partial output is possible, so do not generate another job ID or automatically retry. HTTP 502 accompanies a new failed/unknown result. HTTP 200 can also return a previously recorded failure; always read `outcome.status`.

To verify duplicate suppression during the **same agent runtime**, repeat the request using the retained `$testBody`:

```powershell
Invoke-RestMethod "$base/test-print" -Method Post -Headers $headers -ContentType 'application/json' -Body $testBody | ConvertTo-Json -Depth 5
```

It must return the existing record and produce no second ticket. Do not repeat the ID after restarting the agent; the POC ledger is not durable.

## 5. Optional custom /print request

This intentionally creates another ticket with a new jobId. Skip it until the sample has been inspected.

```powershell
$custom = @{
    jobId = [guid]::NewGuid().ToString('D')
    lines = @(
        @{ text = 'KUHINJA'; size = 16; bold = $true },
        @{ text = 'STO 2'; size = 18; bold = $true },
        @{ text = 'č ć ž š đ Č Ć Ž Š Đ'; size = 11 }
    )
} | ConvertTo-Json -Depth 4
Invoke-RestMethod "$base/print" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($custom)) | ConvertTo-Json -Depth 5
```

For BAR, stop the agent after submissions finish, change `station` to `BAR` in agent.local.json and restart. The test heading becomes ŠANK. Kitchen and Bar use the same Windows submission path. Receipt station is rejected in this POC; its future PREVIEW/SILENT choice is documented in PHASE2.md.

## If no paper comes out

Send the test `jobId`, complete JSON outcome/error, `/health` and `/printers` output, and these logs:

```powershell
Get-Content .\artifacts\agent.log -Tail 100
Get-Content .\artifacts\agent-error.log -Tail 100
Get-Printer -Name 'POS-58 (1)' | Format-List Name,DriverName,PortName,PrinterStatus
Get-PrintJob -PrinterName 'POS-58 (1)' | Format-Table ID,DocumentName,JobStatus,SubmittedTime
```

Also report whether there was any paper movement, blank output, clipped text or dialog. Send a ticket photo if paper appears. Do not send the token, environment secrets or unrelated job/customer contents. Do not clear the Windows queue or resubmit with new IDs while output is uncertain.

After a settled test, stop only the agent process started above:

```powershell
Stop-Process -Id $agent.Id
```

No commit, push, deployment, database migration or production integration is part of this test.
