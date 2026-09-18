$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$startScript = Join-Path $PSScriptRoot "start-courier.ps1"
$taskName = "Courier"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $startScript) `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

$uninstall = Join-Path $PSScriptRoot "uninstall-autostart.ps1"
Write-Host ("Registered scheduled task '{0}'. Courier will start after this user logs on." -f $taskName)
Write-Host ("Working directory: {0}" -f $root)
Write-Host ("Log: {0}" -f (Join-Path $root "tmp\courier-autostart.log"))
Write-Host ("Uninstall: powershell -File {0}" -f $uninstall)
