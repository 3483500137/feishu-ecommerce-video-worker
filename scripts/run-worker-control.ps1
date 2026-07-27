$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$controller = Join-Path $PSScriptRoot 'worker-control.js'
$logPath = Join-Path $projectRoot 'logs\worker-control-launcher.log'

function Write-LauncherLog {
  param([string]$Message)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

try {
  $nodeCandidates = @(
    [Environment]::GetEnvironmentVariable('FEISHU_WORKER_NODE', 'User'),
    'E:\Node js\node.exe',
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

  if (-not $nodeCandidates -or -not @($nodeCandidates)[0]) {
    throw 'Node.js not found. Set FEISHU_WORKER_NODE to node.exe.'
  }

  $nodeExe = @($nodeCandidates)[0]
  $process = Start-Process -FilePath $nodeExe -ArgumentList @($controller) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
  $process.WaitForExit()
  exit $process.ExitCode
} catch {
  Write-LauncherLog "worker control launcher failed: $($_.Exception.Message)"
  exit 1
}
