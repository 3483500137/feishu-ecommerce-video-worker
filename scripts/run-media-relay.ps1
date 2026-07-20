$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
& node '.\src\media-relay-server.js'
exit $LASTEXITCODE
