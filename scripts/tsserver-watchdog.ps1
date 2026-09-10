# tsserver-watchdog.ps1 — kill runaway tsserver.js processes (>1.5 GB working set).
# Why: recurring tsserver leak caused the 2026-08-19 and 2026-08-21 WezTerm wedges
# (25 GB / 2.4 GB / 2 GB instances) and starved the yolo26 model loads.
# Operator-approved 2026-08-21 (grill session). Runs every 15 min via scheduled
# task PyApps-TsserverWatchdog. Logs every kill (with parent process, to trace the
# spawner) to Py Apps/_intel/evidence/tsserver-watchdog.log. tsserver respawns on
# demand, so a kill costs at most a brief editor re-index.

$limitBytes = 1.5GB
$logPath = 'G:\_OneDrive\OneDrive\Desktop\Py Apps\_intel\evidence\tsserver-watchdog.log'

$offenders = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*tsserver.js*' -and $_.WorkingSetSize -gt $limitBytes }

foreach ($p in $offenders) {
    $parentName = 'unknown'
    try {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
        if ($parent) { $parentName = $parent.Name }
    } catch {}
    $mb = [math]::Round($p.WorkingSetSize / 1MB)
    try {
        Stop-Process -Id $p.ProcessId -Force -Confirm:$false -ErrorAction Stop
        $line = "$(Get-Date -Format o) KILLED pid=$($p.ProcessId) ws=${mb}MB parent=$parentName($($p.ParentProcessId))"
    } catch {
        $line = "$(Get-Date -Format o) FAILED pid=$($p.ProcessId) ws=${mb}MB parent=$parentName($($p.ParentProcessId)) err=$($_.Exception.Message)"
    }
    Add-Content -Path $logPath -Value $line -Encoding utf8
}
