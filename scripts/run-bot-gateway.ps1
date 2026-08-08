$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $projectRoot 'logs\bot-gateway.log'

function Write-BotLog {
  param([string]$Message)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

try {
  $nodeExe = @(
    [Environment]::GetEnvironmentVariable('FEISHU_WORKER_NODE', 'User'),
    'E:\Node js\node.exe',
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $nodeExe) { throw '未找到Node.js；请设置FEISHU_WORKER_NODE或将node加入PATH。' }
  Set-Location -LiteralPath $projectRoot
  Write-BotLog "starting Feishu Bot Gateway with $nodeExe"
  & $nodeExe '.\src\bot-gateway-server.js'
  exit $LASTEXITCODE
} catch {
  Write-BotLog "bot gateway failed: $($_.Exception.Message)"
  exit 1
}
