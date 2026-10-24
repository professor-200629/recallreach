# Starts Docker Desktop on Windows builds where Docker cannot delete its own AF_UNIX
# socket files (seen on Windows 11 26H2 build 26300 with Docker Desktop 4.64:
# "remove ...\Docker\run\<name>: The file cannot be accessed by the system").
# Windows refuses to delete those socket entries, but WSL can, so this script removes
# them through WSL before starting Docker Desktop. It deletes only socket entries
# (reparse points) in Docker's own runtime folders; Docker recreates them on start.
#
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File scripts\windows\start-docker-desktop.ps1
param([string]$Distro = 'Ubuntu', [int]$TimeoutSeconds = 240, [int]$StableSeconds = 60)

$ErrorActionPreference = 'Stop'
$dockerExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$runDirs = @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")

function Test-Engine {
  $job = Start-Job { docker info --format '{{.ServerVersion}}' 2>$null }
  $ok = $false
  if (Wait-Job $job -Timeout 12) { $ok = [bool](Receive-Job $job) } else { Stop-Job $job }
  Remove-Job $job -Force
  return $ok
}

Write-Output 'Stopping Docker Desktop (if running)...'
Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch {} }
Start-Sleep -Seconds 4

$sockets = foreach ($d in $runDirs) { if (Test-Path $d) { Get-ChildItem -LiteralPath $d -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | Where-Object { -not $_.PSIsContainer } } }
if ($sockets) {
  $wslPaths = $sockets | ForEach-Object { '/mnt/' + $_.FullName.Substring(0, 1).ToLower() + ($_.FullName.Substring(2) -replace '\\', '/') }
  Write-Output ("Removing {0} leftover socket(s) via WSL: {1}" -f @($sockets).Count, (($sockets | ForEach-Object Name) -join ', '))
  & wsl.exe -d $Distro -e rm -f -- @wslPaths
} else { Write-Output 'No leftover sockets.' }

Write-Output 'Starting Docker Desktop...'
$start = Get-Date
Start-Process $dockerExe
$readyAt = $null
while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSeconds) {
  Start-Sleep -Seconds 6
  if (Test-Engine) {
    if (-not $readyAt) { $readyAt = Get-Date; Write-Output ("Engine answered after {0:N0} s; checking it stays up for {1} s..." -f ((Get-Date) - $start).TotalSeconds, $StableSeconds) }
    elseif (((Get-Date) - $readyAt).TotalSeconds -ge $StableSeconds) { Write-Output 'Docker Desktop is running and stable.'; exit 0 }
  } elseif ($readyAt) { Write-Output 'Engine stopped answering after it started. Check Docker Desktop for an error dialog, then rerun this script.'; exit 1 }
}
Write-Output "Docker Desktop did not become ready within $TimeoutSeconds s."
exit 1
