$ErrorActionPreference = 'Stop'

$workerTaskName = 'FeishuEcommerceVideoWorker'
$controllerTaskName = 'FeishuEcommerceVideoWorkerController'
$hiddenLauncher = Join-Path $PSScriptRoot 'run-worker-hidden.vbs'
$workerRunner = Join-Path $PSScriptRoot 'run-worker.ps1'
$controllerRunner = Join-Path $PSScriptRoot 'run-worker-control.ps1'

function New-HiddenScriptAction {
  param([string]$ScriptPath)
  New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$hiddenLauncher`" `"$ScriptPath`""
}

function New-MinutelyTrigger {
  New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
}

function New-WorkerTaskSettings {
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4)
  $settings.Hidden = $true
  $settings
}

function Register-OrUpdateTask {
  param(
    [string]$TaskName,
    [string]$ScriptPath
  )

  $action = New-HiddenScriptAction -ScriptPath $ScriptPath
  $settings = New-WorkerTaskSettings
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

  if ($existing) {
    $existing.Actions = @($action)
    $existing.Settings.Hidden = $true
    Set-ScheduledTask -InputObject $existing | Out-Null
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Output "Scheduled task updated: $TaskName"
    return
  }

  $trigger = New-MinutelyTrigger
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Output "Scheduled task installed: $TaskName"
}

Register-OrUpdateTask -TaskName $workerTaskName -ScriptPath $workerRunner
Register-OrUpdateTask -TaskName $controllerTaskName -ScriptPath $controllerRunner
