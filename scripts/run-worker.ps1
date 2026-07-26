$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherLog = Join-Path $projectRoot 'logs\worker-launcher.log'

function Write-LauncherLog {
  param([string]$Message)
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $launcherLog -Value $line -Encoding UTF8
}

try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcherLog) | Out-Null

  $nodeCandidates = @(
    [Environment]::GetEnvironmentVariable('FEISHU_WORKER_NODE', 'User'),
    'E:\Node js\node.exe',
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

  if (-not $nodeCandidates -or -not @($nodeCandidates)[0]) {
    throw '未找到 Node.js，可设置用户环境变量 FEISHU_WORKER_NODE 指向 node.exe'
  }

  $nodeExe = @($nodeCandidates)[0]
  Write-LauncherLog "starting worker with $nodeExe"

  $timeoutFromEnv = [Environment]::GetEnvironmentVariable('FEISHU_WORKER_TIMEOUT_MINUTES', 'User')
  $workerTimeoutMinutes = 195
  if ($timeoutFromEnv) {
    $parsedTimeout = 0
    if ([int]::TryParse($timeoutFromEnv, [ref]$parsedTimeout) -and $parsedTimeout -gt 0) {
      $workerTimeoutMinutes = $parsedTimeout
    }
  }
  $workerTimeoutMs = [Math]::Min([int]::MaxValue, $workerTimeoutMinutes * 60 * 1000)
  $workerLock = Join-Path $projectRoot 'runtime\worker.lock'

  $env:XYQ_ACCESS_KEY = [Environment]::GetEnvironmentVariable('XYQ_ACCESS_KEY', 'User')
  $env:KIMI_API_KEY = [Environment]::GetEnvironmentVariable('KIMI_API_KEY', 'User')
  $env:NEWAPI_API_KEY = [Environment]::GetEnvironmentVariable('NEWAPI_API_KEY', 'User')
  Set-Location -LiteralPath $projectRoot
  $workerProcess = Start-Process -FilePath $nodeExe -ArgumentList @('.\src\worker.js', '--once') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
  if (-not $workerProcess.WaitForExit($workerTimeoutMs)) {
    Write-LauncherLog "worker timed out after $workerTimeoutMinutes minutes; stopping pid $($workerProcess.Id)"
    Stop-Process -Id $workerProcess.Id -Force
    if (Test-Path -LiteralPath $workerLock) {
      $lockedPid = (Get-Content -LiteralPath $workerLock -Raw).Trim()
      if ($lockedPid -eq [string]$workerProcess.Id) {
        Remove-Item -LiteralPath $workerLock -Force
        Write-LauncherLog "removed stale worker.lock for pid $($workerProcess.Id)"
      }
    }
    exit 124
  }
  $exitCode = $workerProcess.ExitCode
  Write-LauncherLog "worker exited with code $exitCode"
  exit $exitCode
} catch {
  Write-LauncherLog "worker launcher failed: $($_.Exception.Message)"
  exit 1
}
