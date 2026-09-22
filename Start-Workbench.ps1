$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$bundledNode = Join-Path $taskRoot 'runtime/node.exe'
$nodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
$port = if ($env:PORT) { [int]$env:PORT } else { 4310 }
$baseUrl = 'http://127.0.0.1:' + $port
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/index.html'))) {
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
}
$running = $false
try { $health = Invoke-RestMethod ($baseUrl + '/api/health') -TimeoutSec 2; $running = $health.ok -eq $true } catch {}
if (-not $running) {
    New-Item -ItemType Directory -Path (Join-Path $taskRoot '.workbench') -Force | Out-Null
    Start-Process -FilePath $nodePath -ArgumentList 'server/hub.mjs' -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot '.workbench/server.log') -RedirectStandardError (Join-Path $taskRoot '.workbench/server-error.log')
    for ($i=0; $i -lt 30; $i++) {
        try { $health = Invoke-RestMethod ($baseUrl + '/api/health') -TimeoutSec 1; $running = $health.ok -eq $true; if ($running) { break } } catch { Start-Sleep -Milliseconds 300 }
    }
    if (-not $running) { throw 'Unable to start Codex Workbench. Check .workbench/server-error.log.' }
}
$edgePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'
if ($env:WORKBENCH_NO_OPEN -ne '1') {
    if (Test-Path -LiteralPath $edgePath) { Start-Process -FilePath $edgePath -ArgumentList ('--app=' + $baseUrl) }
    else { Start-Process $baseUrl }
}
