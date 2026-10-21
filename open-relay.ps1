param([switch]$InWindow)
$ErrorActionPreference = 'Stop'
if ($InWindow) {
    Set-Location -LiteralPath $PSScriptRoot
    # Opening a second UI must not collide with another UI's REST listener.
    if (-not $env:SERVER_PORT) { $env:SERVER_PORT = '0' }
    & (Join-Path $PSScriptRoot 'relay.cmd')
    return
}
$terminal = (Get-Command wt.exe -ErrorAction Stop).Source
$powerShell = (Get-Command pwsh.exe -ErrorAction Stop).Source
Start-Process -FilePath $terminal -ArgumentList @(
    '-w', 'new', 'new-tab', '--title', 'Relay', '-d', "`"$PSScriptRoot`"",
    "`"$powerShell`"", '-NoLogo', '-NoExit', '-File', "`"$PSCommandPath`"", '-InWindow'
)
