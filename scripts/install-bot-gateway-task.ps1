$ErrorActionPreference = 'Stop'
$taskName = 'FeishuWorkflowBotGateway'
$hiddenLauncher = Join-Path $PSScriptRoot 'run-worker-hidden.vbs'
$runner = Join-Path $PSScriptRoot 'run-bot-gateway.ps1'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$hiddenLauncher`" `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
$settings.Hidden = $true
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output "Scheduled task installed: $taskName"
