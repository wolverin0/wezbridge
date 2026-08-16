# start-board-server.ps1 - idempotent launcher for the fleet board server
# (T-0140). Follows the fleet's stage-4 watcher pattern: a Task Scheduler job
# runs this on logon AND on a 1-minute repetition; the already-running guard
# makes the repetition a restart-on-death loop rather than a process leak.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $PSCommandPath
$server = Join-Path $appRoot "server.cjs"
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw "server.cjs missing: $server" }

# Already-running guard: one server only.
# Match "...\board-app\server.cjs" AND a bare "node server.cjs" launched from
# the app dir — but never dashboard-server.cjs (leading separator required).
$existing = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match '[\\/ "]server\.cjs' -and $_.CommandLine -notmatch 'dashboard-server' })
if ($existing.Count -gt 0) {
    Write-Output ("board_server=already_running pid={0}" -f $existing[0].ProcessId)
    return
}

$node = (Get-Command node).Source
$process = Start-Process -FilePath $node -ArgumentList @(('"{0}"' -f $server)) `
    -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $appRoot "server.log") `
    -RedirectStandardError (Join-Path $appRoot "server.err.log")
Start-Sleep -Seconds 2
if ($process.HasExited) { throw "board server exited immediately; see server.err.log" }
Write-Output ("board_server=started pid={0}" -f $process.Id)
