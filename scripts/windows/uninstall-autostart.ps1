$ErrorActionPreference = "Stop"
$taskName = "Courier"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Host "计划任务「$taskName」不存在。"
  exit 0
}
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "已移除计划任务「$taskName」。"
