$ErrorActionPreference = 'Stop'
$taskName = 'FeishuAccountClonerMultiPost'
$legacyTaskName = 'FeishuMultiPostAccountServer'
if (Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false
  Write-Output "Removed legacy scheduled task: $legacyTaskName"
}
$runner = Join-Path $PSScriptRoot 'run-multipost-account-server.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output "Scheduled task installed: $taskName"
