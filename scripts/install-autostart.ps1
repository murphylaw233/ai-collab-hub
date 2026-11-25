$ErrorActionPreference = 'Stop'

$TaskName = 'AICollabHub'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RunnerScript = Join-Path $PSScriptRoot 'run-hub-service.ps1'

Push-Location $ProjectRoot
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$userId = $env:USERNAME
if ($env:USERDOMAIN) {
  $userId = "$($env:USERDOMAIN)\$($env:USERNAME)"
}

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunnerScript`"" `
  -WorkingDirectory $ProjectRoot
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'AI Collab Hub local & remote MCP gateway' `
  -Force | Out-Null

Write-Output "[install-autostart] Registered scheduled task '$TaskName' for $userId (AtLogOn)."
Write-Output "[install-autostart] Manage service with:"
Write-Output "  powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\hub-ctl.ps1`" -Action start|stop|restart|status|logs"
