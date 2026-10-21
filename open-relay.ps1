param([switch]$InWindow,[switch]$Native)
$ErrorActionPreference = 'Stop'
if ($InWindow) {
    Set-Location -LiteralPath $PSScriptRoot
    # Opening a second UI must not collide with another UI's REST listener.
    if (-not $env:SERVER_PORT) { $env:SERVER_PORT = '0' }
    if($Native){ & (Join-Path $PSScriptRoot 'relay.cmd') --ui=native }
    else { & (Join-Path $PSScriptRoot 'relay.cmd') }
    return
}
$terminal = (Get-Command wt.exe -ErrorAction Stop).Source
$powerShell = (Get-Command pwsh.exe -ErrorAction Stop).Source
$relayArguments = @(
    '-w', 'new', 'new-tab', '--title', 'Relay', '-d', "`"$PSScriptRoot`"",
    "`"$powerShell`"", '-NoLogo', '-NoExit', '-File', "`"$PSCommandPath`"", '-InWindow'
)
if($Native){$relayArguments+='-Native'}
Start-Process -FilePath $terminal -ArgumentList $relayArguments
