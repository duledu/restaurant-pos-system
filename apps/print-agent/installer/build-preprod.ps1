<#
.SYNOPSIS
    Builds the TableCore Print Agent installer coherently targeted at
    PREPROD (never Production) — the ONE correct way to produce a
    PREPROD/physical-QA candidate.

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

    BUG #7 (print-agent version source, 2026-09-19) — this script is also
    the ONLY supported way to feed a version into the .iss: it reads
    <Version> from TableCore.PrintAgent.csproj (the single authoritative
    source for the Agent's build version) and passes it to ISCC as
    /DAgentVersion=... . After the build, the script verifies that the EXE
    actually shipped has a ProductVersion whose leading label matches that
    csproj <Version>; if the captured EXE disagrees with the requested
    version, the script fails closed. .iss itself fails to compile if
    /DAgentVersion was not supplied (no independent default). An optional
    PRINT_AGENT_VERSION_OVERRIDE env var exists ONLY for the mismatch-guard
    proof in BUG #7 (it deliberately asks for a version that disagrees
    with the csproj and verifies that the build refuses) — production
    callers MUST NOT set it.

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
# $repoRoot should now point at apps/print-agent (parent of installer/),
# so $repoRoot/TableCore.PrintAgent.csproj is the csproj.
$csprojPath = Join-Path $repoRoot "TableCore.PrintAgent.csproj"
if (-not (Test-Path $csprojPath)) {
    Write-Error "csproj not found at $csprojPath. The script is structurally tied to apps/print-agent/TableCore.PrintAgent.csproj."
    exit 1
}

# BUG #7 — single authoritative version source. Read the Version element
# from the csproj. .NET SDK honors this as AssemblyInformationalVersionAttribute
# AND as Win32 VERSIONINFO ProductVersion / FileVersion. AgentRunner.cs
# reads InformationalVersion at runtime to derive AgentVersion.Current.
[xml]$csprojXml = Get-Content $csprojPath -Raw
$authoritativeVersion = ($csprojXml.Project.PropertyGroup | Where-Object { $_.Version } | Select-Object -First 1).Version.Trim()
if ([string]::IsNullOrWhiteSpace($authoritativeVersion)) {
    Write-Error "FATAL: <Version> element missing or empty in $csprojPath. The .NET project must declare a <Version>."
    exit 1
}

# BUG #7 — mismatch-guard: an explicit override is permitted ONLY for the
# mismatch-guard proof run. Production callers must leave this unset so
# the request is byte-for-byte the csproj's value.
$requestedVersion = $authoritativeVersion
if ($env:PRINT_AGENT_VERSION_OVERRIDE -ne $null -and -not [string]::IsNullOrWhiteSpace($env:PRINT_AGENT_VERSION_OVERRIDE)) {
    $requestedVersion = $env:PRINT_AGENT_VERSION_OVERRIDE.Trim()
    if ($requestedVersion -ne $authoritativeVersion) {
        Write-Host ""
        Write-Host "FAIL CLOSED: VERSION MISMATCH REQUESTED." -ForegroundColor Red
        Write-Host "  csproj <Version> = $authoritativeVersion" -ForegroundColor Red
        Write-Host "  requested         = $requestedVersion" -ForegroundColor Red
        Write-Host ""
        Write-Host "The .iss #define MyAppVersion is sourced from /DAgentVersion and" -ForegroundColor Red
        Write-Host "must equal the EXE's ProductVersion (which .NET SDK derives from" -ForegroundColor Red
        Write-Host "csproj <Version>). Building an installer whose AppVersion disagrees" -ForegroundColor Red
        Write-Host "with the EXE it ships is structurally prohibited by BUG #7." -ForegroundColor Red
        Write-Host ""
        if ($env:FIX7_MISMATCH_PROOF -eq "1") {
            Write-Host "FIX7_MISMATCH_PROOF=1 is set: this run is the deliberate guard test." -ForegroundColor Yellow
            Write-Host "The ISCC step WILL still be allowed to fire so we can observe the" -ForegroundColor Yellow
            Write-Host "guard fail at the post-build verification step too. Remove FIX7_MISMATCH_PROOF" -ForegroundColor Yellow
            Write-Host "for production builds." -ForegroundColor Yellow
        } else {
            exit 1
        }
    } else {
        Write-Host "Notice: PRINT_AGENT_VERSION_OVERRIDE=$requestedVersion matches csproj; override is a no-op." -ForegroundColor Yellow
    }
}

$isccPath = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $isccPath)) {
    Write-Error "Inno Setup 6 (ISCC.exe) not found at $isccPath — install it or update this script's path."
    exit 1
}

Write-Host "Building PREPROD candidate against $PreprodServerUrl ..." -ForegroundColor Cyan
Write-Host "  Agent version (authoritative, from csproj Version element): $authoritativeVersion" -ForegroundColor Cyan
Write-Host "  Agent version (requested via /DAgentVersion):             $requestedVersion" -ForegroundColor Cyan

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
    # BUG #7 — /DAgentVersion is REQUIRED; .iss fails to compile without it.
    & $isccPath "/DAgentServerUrl=$PreprodServerUrl" "/DAgentBypassHeader=$bypassHeader" "/DAgentVersion=$requestedVersion" "TableCorePrintAgent.iss"
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

# BUG #7 — post-build verification: the installer AppVersion, which is the
# user-facing version label that ends up in Add/Remove Programs and
# OutputBaseFilename, must agree with the EXE's ProductVersion that .NET
# derived from the csproj. If the csproj is rc.2 but the ISCC request was
# rc.3 or vice versa, this step is the final safety net and fails closed
# with a non-zero exit.
$publishedExe = Join-Path $repoRoot "bin\Release\net8.0-windows\win-x64\publish\TableCore.PrintAgent.exe"
$publishedProductVersion = ""
if (Test-Path $publishedExe) {
    $publishedFvi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($publishedExe)
    $publishedProductVersion = $publishedFvi.ProductVersion
    # ProductVersion may include SourceLink `+<sha>` suffix. Strip it.
    $plusIdx = $publishedProductVersion.IndexOf('+')
    if ($plusIdx -gt 0) { $publishedProductVersion = $publishedProductVersion.Substring(0, $plusIdx) }
}

Write-Host ""
Write-Host "PREPROD installer built successfully:" -ForegroundColor Green
Write-Host "  Path:                   $outputPath" -ForegroundColor Green
Write-Host "  Size:                   $size bytes" -ForegroundColor Green
Write-Host "  SHA-256:                $($hash.Hash)" -ForegroundColor Green
Write-Host "  Requested /DAgentVersion: $requestedVersion" -ForegroundColor Green
Write-Host "  Embedded EXE ProductVersion (after stripping SourceLink): $publishedProductVersion" -ForegroundColor Green

# BUG #7 — final guard: the EXE's user-facing version label MUST equal the
# requested version. Fail closed unless we're explicitly running the proof.
if ($publishedProductVersion -ne $requestedVersion) {
    Write-Host ""
    Write-Host "FAIL CLOSED: POST-BUILD VERSION MISMATCH." -ForegroundColor Red
    Write-Host "  Requested /DAgentVersion  = $requestedVersion" -ForegroundColor Red
    Write-Host "  EXE ProductVersion label  = $publishedProductVersion" -ForegroundColor Red
    Write-Host ""
    if ($env:FIX7_MISMATCH_PROOF -eq "1") {
        Write-Host "FIX7_MISMATCH_PROOF=1: guard correctly identified the simulated mismatch and refused to ship." -ForegroundColor Yellow
        Write-Host "This is the expected outcome for the proof run." -ForegroundColor Yellow
        exit 0
    }
    exit 1
}
