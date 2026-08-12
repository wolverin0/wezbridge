# Monitors passive WhatsApp bot roadmap gates and wakes the existing `wabot` pane.
# Uses the deterministic poke-pane transport; never starts Claude/Codex or spawns panes.
# Resolves a live WezTerm GUI socket and the operator-owned tab title at fire time.
# Writes last-poke state only after verified delivery; no-op runs cannot look successful.
# Run every five minutes; ordinary continuation is rate-limited to two hours.
# A 03:15-03:45 ART run prioritizes post-backup TR-01 evidence.
# Safe actions only: public health reads, local state/log writes, and terminal input.
[CmdletBinding()]
param(
    [switch]$ForcePoke,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $PSCommandPath
$pokeScript = Join-Path $scriptRoot 'poke-pane.cjs'
$promptPath = Join-Path $scriptRoot 'wabot-roadmap-monitor.prompt.txt'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'WhatsAppBotRoadmapAutopilot'
$statePath = Join-Path $runtimeRoot 'wabot-roadmap-monitor-state.json'
$logPath = Join-Path $runtimeRoot 'wabot-roadmap-monitor.log'
$weztermSocketRoot = Join-Path $env:USERPROFILE '.local\share\wezterm'
$mutex = [Threading.Mutex]::new($false, 'Local\WhatsAppBotRoadmapMonitor')
$hasMutex = $false

function Write-MonitorLog {
    param([Parameter(Mandatory)][string]$Message)
    $line = '{0} {1}' -f [DateTimeOffset]::Now.ToString('o'), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Read-MonitorState {
    if (-not (Test-Path -LiteralPath $statePath)) {
        return [ordered]@{
            lastPokeAttemptAt = $null
            lastVerifiedPokeAt = $null
            lastBackupPokeDate = $null
            outageActive = $false
            lastHealthObservedAt = $null
        }
    }
    try {
        $raw = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        return [ordered]@{
            lastPokeAttemptAt = $raw.lastPokeAttemptAt
            lastVerifiedPokeAt = $raw.lastVerifiedPokeAt
            lastBackupPokeDate = $raw.lastBackupPokeDate
            outageActive = $raw.outageActive -eq $true
            lastHealthObservedAt = $raw.lastHealthObservedAt
        }
    } catch {
        return [ordered]@{
            lastPokeAttemptAt = $null
            lastVerifiedPokeAt = $null
            lastBackupPokeDate = $null
            outageActive = $false
            lastHealthObservedAt = $null
        }
    }
}

function Write-MonitorState {
    param([Parameter(Mandatory)][Collections.IDictionary]$State)
    $temporaryPath = "$statePath.tmp"
    $json = $State | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
}

function Invoke-SanitizedHealthRead {
    param([Parameter(Mandatory)][string]$Uri)
    $handler = [Net.Http.HttpClientHandler]::new()
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(8)
    try {
        $response = $client.GetAsync($Uri).GetAwaiter().GetResult()
        return [int]$response.StatusCode
    } catch {
        return 0
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }
}

function Get-LiveGuiSockets {
    $guiProcesses = @(Get-Process -Name 'wezterm-gui' -ErrorAction SilentlyContinue)
    foreach ($process in $guiProcesses) {
        $candidate = Join-Path $weztermSocketRoot ("gui-sock-{0}" -f $process.Id)
        if (Test-Path -LiteralPath $candidate) { $candidate }
    }
}

function Invoke-VerifiedPoke {
    param(
        [Parameter(Mandatory)][string]$Reason,
        [switch]$ProbeOnly
    )
    $promptReference = $promptPath -replace '\\', '/'
    $message = "AUTOMATED_ROADMAP_POKE id=$($([DateTimeOffset]::Now).ToUnixTimeSeconds()) reason=$Reason. Read and execute $promptReference. Perform real work before reporting progress; do not spawn panes."
    $messagePath = Join-Path $runtimeRoot 'wabot-roadmap-monitor-current.txt'
    [IO.File]::WriteAllText($messagePath, $message, [Text.UTF8Encoding]::new($false))

    $sockets = @(Get-LiveGuiSockets)
    if ($sockets.Count -eq 0) {
        Write-MonitorLog 'poke-failed reason=no-live-gui-socket'
        return 'failed'
    }

    foreach ($socket in $sockets) {
        $priorSocket = $env:WEZTERM_UNIX_SOCKET
        try {
            $env:WEZTERM_UNIX_SOCKET = $socket
            $arguments = @($pokeScript, '--tab-title', 'wabot', '--file', $messagePath)
            if ($ProbeOnly) { $arguments += '--dry-run' }
            $output = @(& node @arguments 2>&1)
            $exitCode = $LASTEXITCODE
            $summary = ($output -join ' ') -replace '[\r\n]+', ' '
            if ($summary.Length -gt 500) { $summary = $summary.Substring(0, 500) }
            Write-MonitorLog ("poke-attempt exit={0} socket={1} result={2}" -f $exitCode, (Split-Path -Leaf $socket), $summary)
            $deliveryVerified = $summary -match '(?<!UN)VERIFIED \(echo found in pane\)'
            if ($exitCode -eq 0 -and ($ProbeOnly -or $deliveryVerified)) {
                return $(if ($ProbeOnly -or $deliveryVerified) { 'verified' } else { 'enqueued' })
            }
        } finally {
            $env:WEZTERM_UNIX_SOCKET = $priorSocket
        }
    }
    return 'failed'
}

try {
    Add-Type -AssemblyName System.Net.Http
    if (-not (Test-Path -LiteralPath $runtimeRoot)) {
        $null = New-Item -ItemType Directory -Path $runtimeRoot
    }
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) { exit 0 }
    if (-not (Test-Path -LiteralPath $pokeScript)) { throw 'poke-pane.cjs is missing' }
    if (-not (Test-Path -LiteralPath $promptPath)) { throw 'monitor prompt is missing' }

    if ($DryRun) {
        if ((Invoke-VerifiedPoke -Reason 'dry-run-transport-proof' -ProbeOnly) -eq 'verified') { exit 0 }
        exit 4
    }

    $state = Read-MonitorState
    $now = [DateTimeOffset]::Now
    $liveStatus = Invoke-SanitizedHealthRead -Uri 'https://wisp-otacon.puntofutura.com.ar/health/live'
    $readyStatus = Invoke-SanitizedHealthRead -Uri 'https://wisp-otacon.puntofutura.com.ar/health'
    $outageActive = $liveStatus -eq 200 -and $readyStatus -eq 503
    $transition = $null
    if ($outageActive -and -not $state.outageActive) { $transition = 'tr07-outage-started' }
    if (-not $outageActive -and $state.outageActive -and $liveStatus -eq 200 -and $readyStatus -eq 200) { $transition = 'tr07-outage-recovered' }
    $state.outageActive = $outageActive
    $state.lastHealthObservedAt = $now.ToString('o')

    $reason = $null
    if ($ForcePoke) {
        $reason = 'scheduled-task-end-to-end-proof'
    } elseif ($transition) {
        $reason = $transition
    } elseif ($now.Hour -eq 3 -and $now.Minute -ge 15 -and $now.Minute -le 45 -and $state.lastBackupPokeDate -ne $now.ToString('yyyy-MM-dd')) {
        $reason = 'post-03:00-tr01-backup-observation'
    } else {
        $lastPoke = if ($state.lastPokeAttemptAt) { [DateTimeOffset]::Parse([string]$state.lastPokeAttemptAt) } else { [DateTimeOffset]::MinValue }
        if (($now - $lastPoke).TotalHours -ge 2) { $reason = 'two-hour-roadmap-continuation' }
    }

    if ($reason) {
        $pokeResult = Invoke-VerifiedPoke -Reason $reason
        if ($pokeResult -ne 'failed') {
            $state.lastPokeAttemptAt = $now.ToString('o')
            if ($pokeResult -eq 'verified') { $state.lastVerifiedPokeAt = $now.ToString('o') }
            if ($reason -eq 'post-03:00-tr01-backup-observation') { $state.lastBackupPokeDate = $now.ToString('yyyy-MM-dd') }
            Write-MonitorState -State $state
            exit 0
        }
        Write-MonitorState -State $state
        exit 5
    }

    Write-MonitorState -State $state
    Write-MonitorLog ("observe-only live={0} ready={1} outage={2}" -f $liveStatus, $readyStatus, $outageActive)
    exit 0
} catch {
    Write-MonitorLog ("monitor-failed code={0}" -f $_.FullyQualifiedErrorId)
    exit 10
} finally {
    if ($hasMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
