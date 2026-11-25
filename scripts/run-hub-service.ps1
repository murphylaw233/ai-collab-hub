$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot 'logs'
$OutLog = Join-Path $LogDir 'hub.out.log'
$ErrLog = Join-Path $LogDir 'hub.err.log'
$PidFile = Join-Path $LogDir 'hub.pid'
$EntryFile = Join-Path $ProjectRoot 'dist\src\index.js'

$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Rotate-LogIfLarge {
  param([string]$Path, [int64]$MaxBytes = 5242880)
  if (Test-Path -LiteralPath $Path) {
    $info = Get-Item -LiteralPath $Path
    if ($info.Length -gt $MaxBytes) {
      $prev = "$Path.prev"
      Move-Item -LiteralPath $Path -Destination $prev -Force
    }
  }
}

Rotate-LogIfLarge -Path $OutLog
Rotate-LogIfLarge -Path $ErrLog

$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) {
  $NodeExe = 'C:\Program Files\nodejs\node.exe'
}
if (-not (Test-Path -LiteralPath $NodeExe)) {
  throw "node.exe not found: $NodeExe"
}
if (-not (Test-Path -LiteralPath $EntryFile)) {
  throw "Built entrypoint missing: $EntryFile (run npm run build first)"
}

$proc = Start-Process `
  -FilePath $NodeExe `
  -ArgumentList @('dist\src\index.js') `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -PassThru

Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding Ascii

try {
  $proc.WaitForExit()
  exit $proc.ExitCode
} finally {
  if (Test-Path -LiteralPath $PidFile) {
    $savedPid = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($savedPid -eq "$($proc.Id)") {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }
  }
}
