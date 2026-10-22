$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
Set-Location -LiteralPath $taskRoot
$bundledNode = Join-Path $taskRoot 'runtime/node.exe'
$nodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
$port = if ($env:PORT) { [int]$env:PORT } else { 24319 }
$baseUrl = 'http://127.0.0.1:' + $port
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/index.html'))) {
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
}
$running = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $baseUrl = 'http://127.0.0.1:' + $port
    try { $health = Invoke-RestMethod ($baseUrl + '/api/health') -TimeoutSec 1; $running = $health.ok -eq $true -and $null -ne $health.heapUsed } catch {}
    if ($running) { break }
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    $available = $false
    try { $probe.Start(); $available = $true } catch {} finally { $probe.Stop() }
    if ($available) { break }
    Write-Host "Port $port is occupied; trying another port."
    $port++
}
if (-not $running -and -not $available) { throw 'No available Workbench port found.' }
if (-not $running) {
    New-Item -ItemType Directory -Path (Join-Path $taskRoot '.workbench') -Force | Out-Null
    $previousPort = $env:PORT
    try {
        $env:PORT = [string]$port
        Start-Process -FilePath $nodePath -ArgumentList 'server/hub.mjs' -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot '.workbench/server.log') -RedirectStandardError (Join-Path $taskRoot '.workbench/server-error.log')
    } finally { $env:PORT = $previousPort }
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
