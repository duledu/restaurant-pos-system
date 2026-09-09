param([string]$Dotnet = 'dotnet', [string]$AgentExecutable)
$ErrorActionPreference = 'Stop'
$agentRoot = $PSScriptRoot
$agentDll = Join-Path $agentRoot 'bin/Debug/net8.0-windows/TableCore.PrintAgent.dll'
$testRoot = Join-Path $agentRoot ('artifacts/api-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$oldToken = $env:TABLECORE_AGENT_TOKEN
$oldEndpoint = $env:Kestrel__Endpoints__Injected__Url
$env:Kestrel__Endpoints__Injected__Url = 'http://127.0.0.1:17832'
$env:TABLECORE_AGENT_TOKEN = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
@{ station = 'KITCHEN'; printerName = 'TableCore-Missing-' + [guid]::NewGuid(); paperWidthMm = 58 } |
    ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $testRoot 'agent.local.json')
Add-Type -AssemblyName System.Net.Http
$client = [System.Net.Http.HttpClient]::new()
function Request($method, $path, $body = $null, $id = $null, $origin = $null, $authenticated = $true) {
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method), "http://127.0.0.1:17831$path")
    if ($authenticated) { $request.Headers.TryAddWithoutValidation('Authorization', "Bearer $env:TABLECORE_AGENT_TOKEN") | Out-Null }
    if ($id) { $request.Headers.TryAddWithoutValidation('X-Request-Id', $id) | Out-Null }
    if ($origin) { $request.Headers.TryAddWithoutValidation('Origin', $origin) | Out-Null }
    if ($null -ne $body) { $request.Content = [System.Net.Http.StringContent]::new($body, [Text.Encoding]::UTF8, 'application/json') }
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try { return @{ code = [int]$response.StatusCode; body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() } }
        finally { $response.Dispose() }
    } finally { $request.Dispose() }
}
function Check($condition, $name) { if (!$condition) { throw "FAIL: $name" }; Write-Output "PASS: $name" }
$process = $null
try {
    if (Get-NetTCPConnection -LocalPort 17831 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 17831 already in use; stop the existing agent first.' }
    $launch = @{ FilePath = $Dotnet; ArgumentList = @("`"$agentDll`"") }
    if ($AgentExecutable) { $launch = @{ FilePath = (Resolve-Path -LiteralPath $AgentExecutable).Path } }
    $process = Start-Process @launch -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot 'stdout.log') -RedirectStandardError (Join-Path $testRoot 'stderr.log')
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        if ($process.HasExited) { throw 'Agent exited; inspect artifacts API logs.' }
        try { $health = Request GET /health; if ($health.code -eq 200) { $ready = $true; break } } catch { }
    }
    Check $ready 'health endpoint'
    Check ((Request GET /health -authenticated $false).code -eq 403) 'unauthenticated request denied'
    Check ((Request GET /health -origin 'https://untrusted.example').code -eq 403) 'browser origin denied'
    Check ((Request GET /printers).code -eq 200) 'printer enumeration endpoint'
    Check ((Request POST /print '{"lines":[]}' ([guid]::NewGuid().ToString())).code -eq 400) 'invalid ticket denied'
    $id = [guid]::NewGuid().ToString()
    $failed = Request POST /test-print '{}' $id
    Check ($failed.code -eq 502 -and ($failed.body | ConvertFrom-Json).outcome.status -eq 'FAILED_BEFORE_SUBMISSION') 'missing printer reports pre-submission failure'
    $repeated = Request POST /test-print '{}' $id.ToUpperInvariant()
    Check ($repeated.code -eq 200 -and ($repeated.body | ConvertFrom-Json).outcome.status -eq 'FAILED_BEFORE_SUBMISSION') 'repeat returns recorded outcome, HTTP 200 is not print success'
    Check ((Request GET "/jobs/$id").code -eq 200) 'outcome lookup'
    Check ((Request POST /print '{"lines":[{"text":"different"}]}' $id).code -eq 409) 'request ID content conflict'
    $customId = [guid]::NewGuid().ToString('D')
    $customBody = @{ jobId = $customId; lines = @(@{ text = 'Kitchen test'; size = 11 }) } | ConvertTo-Json -Depth 4
    $custom = Request POST /print $customBody
    Check ($custom.code -eq 502 -and ($custom.body | ConvertFrom-Json).jobId -eq $customId) 'print accepts body jobId without header'
    $customRepeat = Request POST /print $customBody
    Check ($customRepeat.code -eq 200 -and $customRepeat.body -eq $custom.body) 'duplicate body jobId returns identical recorded outcome'
    $conflictBody = @{ jobId = $customId; lines = @(@{ text = 'Changed' }) } | ConvertTo-Json -Depth 4
    Check ((Request POST /print $conflictBody).code -eq 409) 'duplicate body jobId with changed content rejected'
    Check ((Request POST /print $customBody ([guid]::NewGuid().ToString('D'))).code -eq 400) 'conflicting header and body IDs rejected'
    Check ((Request POST /print '{"jobId":"invalid","lines":[{"text":"test"}]}').code -eq 400) 'invalid body jobId rejected'
    Check ((Request POST /print '{').code -eq 400) 'malformed request JSON rejected'
    $testBodyId = [guid]::NewGuid().ToString('D')
    $testBody = @{ jobId = $testBodyId } | ConvertTo-Json
    Check ((Request POST /test-print $testBody).code -eq 502) 'test-print accepts body jobId'
    $accepted = @(Get-Content (Join-Path $testRoot 'stdout.log') | Where-Object { $_ -match "Request $customId ACCEPTED" })
    Check ($accepted.Count -eq 1) 'duplicate job enters submission workflow only once'
    $listeners = @(Get-NetTCPConnection -OwningProcess $process.Id -State Listen)
    Check ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -eq '127.0.0.1' -and $listeners[0].LocalPort -eq 17831) 'loopback-only listener; environment endpoint override ignored'
    if ($AgentExecutable) {
        $runtimeModule = @((Get-Process -Id $process.Id).Modules | Where-Object { $_.ModuleName -eq 'coreclr.dll' })
        $expectedRuntime = Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $AgentExecutable).Path) 'coreclr.dll'
        Check ($runtimeModule.Count -eq 1 -and $runtimeModule[0].FileName -eq $expectedRuntime) 'packaged executable loads its bundled runtime'
        Write-Output '19 API/package tests passed. No physical print attempted.'
    } else {
        Write-Output '18 API tests passed. No physical print attempted.'
    }
} finally {
    if ($process -and !$process.HasExited) { Stop-Process -Id $process.Id; $process.WaitForExit() }
    $client.Dispose()
    $env:TABLECORE_AGENT_TOKEN = $oldToken
    $env:Kestrel__Endpoints__Injected__Url = $oldEndpoint
}
