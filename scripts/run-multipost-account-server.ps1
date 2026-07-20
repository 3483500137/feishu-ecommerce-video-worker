$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
& node '.\src\multipost-account-server.js'
exit $LASTEXITCODE
