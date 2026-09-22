$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $desktop 'Codex Workbench.lnk'))
$link.TargetPath = Join-Path $taskRoot 'Start-Workbench.cmd'
$link.WorkingDirectory = $taskRoot
$link.IconLocation = (Join-Path $taskRoot 'public/workbench.ico') + ',0'
$link.Description = 'Local Codex workflow dashboard'
$link.Save()
Write-Host 'Desktop shortcut created.'
