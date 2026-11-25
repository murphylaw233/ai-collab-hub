param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'logs')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$TaskName = 'AICollabHub'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot 'logs'
$OutLog = Join-Path $LogDir 'hub.out.log'
$ErrLog = Join-Path $LogDir 'hub.err.log'
$PidFile = Join-Path $LogDir 'hub.pid'
$EntryFile = Join-Path $ProjectRoot 'dist\src\index.js'

function Stop-HubService {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $stoppedAny = $false
  if (Test-Path -LiteralPath $PidFile) {
    $rawPid = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $parsedPid = 0
    if ([int]::TryParse($rawPid, [ref]$parsedPid) -and $parsedPid -gt 0) {
      $proc = Get-Process -Id $parsedPid -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq 'node') {
        Stop-Process -Id $parsedPid -Force -ErrorAction Stop
        $stoppedAny = $true
      }
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  }
  $orphanProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dist\src\index.js*' }
  foreach ($p in $orphanProcs) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $stoppedAny = $true
  }
  if ($stoppedAny) {
    $waitUntil = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $waitUntil) {
      $listening = Get-NetTCPConnection -LocalPort 3789 -State Listen -ErrorAction SilentlyContinue
      if (-not $listening) { break }
      Start-Sleep -Milliseconds 200
    }
  }
}

function Start-HubService {
  if (-not (Test-Path -LiteralPath $EntryFile)) {
    Push-Location $ProjectRoot
    try {
      & npm run build
      if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed with exit code $LASTEXITCODE"
      }
    } finally {
      Pop-Location
    }
  }

  Start-ScheduledTask -TaskName $TaskName

  $deadline = (Get-Date).AddSeconds(10)
  $health = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3789/api/health' -TimeoutSec 2
      if ($health -and $health.ok) { break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  if (-not $health -or -not $health.ok) {
    throw "Hub health check failed after starting scheduled task '$TaskName'. Check logs via hub-ctl.ps1 -Action logs."
  }

  Write-Output "[hub-ctl] Started task '$TaskName'"
  $health | ConvertTo-Json -Depth 4
}

switch ($Action) {
  'stop' {
    Stop-HubService
    Write-Output "[hub-ctl] Stopped task '$TaskName'"
  }
  'start' {
    Start-HubService
  }
  'restart' {
    Stop-HubService
    Start-Sleep -Seconds 1
    Start-HubService
  }
  'status' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
      Write-Output "ScheduledTask : $TaskName (State=$($task.State))"
    } else {
      Write-Output "ScheduledTask : $TaskName (Not installed)"
    }
    if (Test-Path -LiteralPath $PidFile) {
      $rawPid = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
      $parsedPid = 0
      $alive = ([int]::TryParse($rawPid, [ref]$parsedPid) -and $null -ne (Get-Process -Id $parsedPid -ErrorAction SilentlyContinue))
      Write-Output "PID File      : $rawPid (Alive=$alive)"
    } else {
      Write-Output "PID File      : none"
    }
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3789/api/health' -TimeoutSec 3
      Write-Output "Health        :"
      $health | ConvertTo-Json -Depth 4
    } catch {
      Write-Output "Health        : unreachable ($($_.Exception.Message))"
    }
  }
  'logs' {
    if (Test-Path -LiteralPath $OutLog) {
      Write-Output '=== hub.out.log (last 40 lines) ==='
      Get-Content -LiteralPath $OutLog -Tail 40
    } else {
      Write-Output '=== hub.out.log (missing) ==='
    }
    if (Test-Path -LiteralPath $ErrLog) {
      $errInfo = Get-Item -LiteralPath $ErrLog
      if ($errInfo.Length -gt 0) {
        Write-Output '=== hub.err.log (last 40 lines) ==='
        Get-Content -LiteralPath $ErrLog -Tail 40
      } else {
        Write-Output '=== hub.err.log (empty) ==='
      }
    }
  }
}
