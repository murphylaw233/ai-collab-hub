$ErrorActionPreference = 'Stop'

$TaskName = 'AICollabHub'
$CtlScript = Join-Path $PSScriptRoot 'hub-ctl.ps1'

if (Test-Path -LiteralPath $CtlScript) {
  & $CtlScript -Action stop
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Output "[uninstall-autostart] Removed scheduled task '$TaskName'."
