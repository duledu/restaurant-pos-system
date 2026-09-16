<#
.SYNOPSIS
    Builds the TableCore Print Agent installer coherently targeted at
    PREPROD (never Production) — the ONE correct way to produce a
    PREPROD/physical-QA candidate, replacing "remember the exact
    `ISCC /DAgentServerUrl=... /DAgentBypassHeader=...` incantation".

.DESCRIPTION
    Physical QA found a real regression: a pilot installer was built by
    invoking ISCC.exe directly with NO /D arguments, which is a perfectly
    valid, intentional invocation for a real PRODUCTION build (see
    TableCorePrintAgent.iss's own [Setup] comments) — but it silently
    produced a PRODUCTION-mode agent (Setup showed
    "Server: mode=Production, endpoint=https://tablecore.net") during what
    was supposed to be PREPROD hardware testing. The installer/agent code
    itself was never wrong; the BUILD INVOCATION was. This script is the
    fail-closed fix for that class of human error: it is the only supported
    way to build a PREPROD candidate, it hardcodes the correct, current
    PREPROD Vercel Preview URL (a stable, non-secret value — see
    docs/git history, commit 96b0024), and it REFUSES to proceed if the
    Vercel Deployment Protection bypass header isn't supplied, instead of
    silently building a PREPROD installer that would just fail at Vercel's
    edge with a 401 on every single request.

.NOTES
    NEVER hardcode the actual bypass secret value in this file, in any
    other repo file, in a commit, or print it to the console/log — it is
    read from an environment variable you set in YOUR OWN terminal
    session, and this script never echoes it. Get the current value from
    Vercel Project Settings -> Deployment Protection -> Protection Bypass
    for Automation (or from whoever last set it) and set it yourself:

        $env:TABLECORE_PREPROD_BYPASS_HEADER = "<the real secret>"
        .\build-preprod.ps1

    If the PREPROD Preview URL below ever stops requiring Deployment
    Protection, this script still works — it just won't need the bypass
    variable (still fails closed with a clear message either way).
#>

$ErrorActionPreference = "Stop"

# Stable, non-secret PREPROD Vercel Preview URL for the `develop` branch —
# safe to hardcode (it is a URL, not a credential). If this project's
# PREPROD deployment URL ever changes, update ONLY this one line.
$PreprodServerUrl = "https://tablecore-git-develop-drake-du.vercel.app"

if ($PreprodServerUrl -eq "https://tablecore.net") {
    Write-Error "PreprodServerUrl must never be the Production host. Refusing to build."
    exit 1
}

$bypassHeader = $env:TABLECORE_PREPROD_BYPASS_HEADER
if ([string]::IsNullOrWhiteSpace($bypassHeader)) {
    Write-Host ""
    Write-Host "FAIL CLOSED: TABLECORE_PREPROD_BYPASS_HEADER is not set." -ForegroundColor Red
    Write-Host "This PREPROD Preview URL currently has Vercel Deployment Protection" -ForegroundColor Red
    Write-Host "enabled — every request (pairing/heartbeat/poll) would be rejected at" -ForegroundColor Red
    Write-Host "Vercel's edge with a generic 401 before ever reaching TableCore's own" -ForegroundColor Red
    Write-Host "code, exactly the failure mode this script exists to prevent shipping" -ForegroundColor Red
    Write-Host "unnoticed. Set it in THIS terminal session (never commit it, never" -ForegroundColor Red
    Write-Host "paste it anywhere else) and re-run:" -ForegroundColor Red
    Write-Host ""
    Write-Host '    $env:TABLECORE_PREPROD_BYPASS_HEADER = "<the current Vercel Protection Bypass for Automation secret>"' -ForegroundColor Yellow
    Write-Host "    .\build-preprod.ps1" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$isccPath = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $isccPath)) {
    Write-Error "Inno Setup 6 (ISCC.exe) not found at $isccPath — install it or update this script's path."
    exit 1
}

Write-Host "Building PREPROD candidate against $PreprodServerUrl ..." -ForegroundColor Cyan

Push-Location $repoRoot
try {
    & "C:\Program Files\dotnet\dotnet.exe" publish -c Release
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)." }
}
finally {
    Pop-Location
}

Push-Location (Join-Path $repoRoot "installer")
try {
    # Never Write-Host/echo $bypassHeader — passed straight through as a
    # process argument, never logged, never written to any file by this
    # script. ISCC's own build log only prints preprocessing PROGRESS
    # lines (section/line numbers), never preprocessor variable VALUES.
    & $isccPath "/DAgentServerUrl=$PreprodServerUrl" "/DAgentBypassHeader=$bypassHeader" "TableCorePrintAgent.iss"
    if ($LASTEXITCODE -ne 0) { throw "ISCC compile failed (exit $LASTEXITCODE)." }
}
finally {
    Pop-Location
}

$outputPath = Join-Path $repoRoot "installer\dist\TableCorePrintSetup-PREPROD.exe"
if (-not (Test-Path $outputPath)) {
    Write-Error "Expected output not found at $outputPath — check the ISCC log above."
    exit 1
}
$hash = Get-FileHash $outputPath -Algorithm SHA256
$size = (Get-Item $outputPath).Length
Write-Host ""
Write-Host "PREPROD installer built successfully:" -ForegroundColor Green
Write-Host "  Path:    $outputPath"
Write-Host "  Size:    $size bytes"
Write-Host "  SHA-256: $($hash.Hash)"
