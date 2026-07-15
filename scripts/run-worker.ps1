$ErrorActionPreference = 'Stop'
$env:XYQ_ACCESS_KEY = [Environment]::GetEnvironmentVariable('XYQ_ACCESS_KEY', 'User')
$env:KIMI_API_KEY = [Environment]::GetEnvironmentVariable('KIMI_API_KEY', 'User')
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
& node '.\src\worker.js' '--once'
exit $LASTEXITCODE
