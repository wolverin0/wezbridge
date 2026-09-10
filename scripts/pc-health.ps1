# pc-health.ps1 — chequeo de salud de la workstation en UN comando, SOLO LECTURA.
# Que cubre: RAM por familia de procesos, mapa de procesos MCP (node/bun/python) por servidor y por
# sesion claude/codex que los engendro, discos, caches grandes, tareas programadas propias en rojo,
# items de inicio. No borra, no mata, no cambia nada: imprime y opcionalmente guarda un .md.
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pc-health.ps1 [-Out artifacts\pc-health-YYYYMMDD.md]
# Origen: paso 1 del plan "optimizar la PC sin breaking changes" (2026-09-02). Correr ANTES y DESPUES de cualquier limpieza.
param([string]$Out = "")
$ErrorActionPreference = 'SilentlyContinue'
$lines = New-Object System.Collections.Generic.List[string]
function W($s) { $script:lines.Add($s); Write-Output $s }
function GB($b) { [math]::Round($b / 1GB, 2) }

W "# pc-health $(Get-Date -Format 'yyyy-MM-dd HH:mm') ($env:COMPUTERNAME)"
$os = Get-CimInstance Win32_OperatingSystem
W ("- RAM libre: {0} GB / {1} GB · uptime {2:d}d {2:hh}h" -f (GB ($os.FreePhysicalMemory*1KB)), (GB ($os.TotalVisibleMemorySize*1KB)), ((Get-Date) - $os.LastBootUpTime))

W "`n## RAM por familia de procesos (top 12)"
W "| proceso | count | GB |`n|---|---|---|"
Get-Process | Group-Object ProcessName | ForEach-Object {
  [pscustomobject]@{ N = $_.Name; C = $_.Count; G = GB (($_.Group | Measure-Object WorkingSet64 -Sum).Sum) }
} | Sort-Object G -Descending | Select-Object -First 12 | ForEach-Object { W "| $($_.N) | $($_.C) | $($_.G) |" }

W "`n## Procesos MCP/agentes (node, bun, python) por servidor"
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'node.exe','bun.exe','python.exe','pythonw.exe','claude.exe','codex.exe' }
function Label($cl) {
  if (-not $cl) { return '?' }
  $c = $cl -replace '"', ''
  if ($c -match 'mcp-server\.cjs') { return 'wezbridge-mcp' }
  if ($c -match 'gitnexus') { return 'gitnexus' }
  if ($c -match 'memorymaster|mm_mcp|memory_master') { return 'memorymaster' }
  if ($c -match 'context7') { return 'context7' }
  if ($c -match 'claude-in-chrome') { return 'claude-in-chrome' }
  if ($c -match 'finalorchestra') { return 'finalorchestra-mcp' }
  if ($c -match 'playwright') { return 'playwright' }
  if ($c -match 'tsserver|typescript') { return 'tsserver' }
  if ($c -match 'dashboard-server|board-app|queue-drain|heartbeat|waker') { return 'wezbridge-daemons' }
  if ($c -match 'npx|npm-cli|npm ') { return 'npx-shim' }
  if ($c -match '\\codex') { return 'codex' }
  if ($c -match '\\claude') { return 'claude-cli' }
  $m = [regex]::Match($c, '([^\\/\s]+\.(cjs|js|mjs|ts|py))'); if ($m.Success) { return $m.Groups[1].Value }
  return $c.Substring(0, [Math]::Min(40, $c.Length))
}
W "| servidor | procesos | GB |`n|---|---|---|"
$procs | Where-Object { $_.Name -ne 'claude.exe' -and $_.Name -ne 'codex.exe' } | ForEach-Object {
  [pscustomobject]@{ L = (Label $_.CommandLine); WS = $_.WorkingSetSize }
} | Group-Object L | ForEach-Object {
  [pscustomobject]@{ L = $_.Name; C = $_.Count; G = GB (($_.Group | Measure-Object WS -Sum).Sum) }
} | Sort-Object G -Descending | ForEach-Object { W "| $($_.L) | $($_.C) | $($_.G) |" }

W "`n## Sesiones claude/codex y los procesos que cuelgan de cada una"
$roots = $procs | Where-Object { $_.Name -in 'claude.exe','codex.exe' }
foreach ($r in $roots) {
  $kids = $procs | Where-Object { $_.ParentProcessId -eq $r.ProcessId }
  $grand = $procs | Where-Object { $kids.ProcessId -contains $_.ParentProcessId }
  $all = @($kids) + @($grand)
  $labels = ($all | ForEach-Object { Label $_.CommandLine } | Group-Object | Sort-Object Name | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ' '
  W ("- {0} pid={1} hijos={2} ({3} GB): {4}" -f $r.Name, $r.ProcessId, $all.Count, (GB (($all | Measure-Object WorkingSetSize -Sum).Sum)), $labels)
}
$alive = @{}; Get-Process | ForEach-Object { $alive[$_.Id] = $true }
$orphans = $procs | Where-Object { $_.Name -in 'node.exe','bun.exe','python.exe' -and -not $alive[[int]$_.ParentProcessId] }
W ("- huerfanos (padre muerto): {0} procesos, {1} GB" -f @($orphans).Count, (GB (($orphans | Measure-Object WorkingSetSize -Sum).Sum)))

W "`n## Discos"
Get-PSDrive -PSProvider FileSystem | Where-Object Used | ForEach-Object { W ("- {0}: libre {1:N0} GB / {2:N0} GB" -f $_.Name, ($_.Free/1GB), (($_.Used+$_.Free)/1GB)) }

W "`n## Caches y temporales (GB; 'Recurse' acotado a 2 niveles para no tardar)"
$paths = @("$env:LOCALAPPDATA\Temp", "$env:LOCALAPPDATA\npm-cache", "$env:LOCALAPPDATA\uv\cache", "$env:LOCALAPPDATA\pip\Cache",
           "$env:USERPROFILE\.cache\huggingface", "$env:USERPROFILE\Downloads", "T:\claudecodetemp", "$env:USERPROFILE\.claude\projects",
           "$env:LOCALAPPDATA\Docker", "$env:LOCALAPPDATA\Microsoft\Windows\INetCache", "$env:USERPROFILE\.bun\install\cache")
foreach ($p in $paths) {
  if (Test-Path $p) {
    $s = (Get-ChildItem $p -Recurse -Force -Depth 2 -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    W ("- {0}: {1} GB (aprox, 2 niveles)" -f $p, (GB $s))
  }
}

W "`n## Tareas programadas propias (no Microsoft) con ultimo resultado != 0 o huerfanas"
$t = Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft\*' }
W "- total no-Microsoft: $($t.Count)"
foreach ($x in $t) {
  $i = Get-ScheduledTaskInfo -TaskName $x.TaskName -TaskPath $x.TaskPath
  if ($x.State -ne 'Disabled' -and $i.LastTaskResult -ne 0 -and $i.LastTaskResult -ne 267009 -and $i.LastTaskResult -ne 267011) {
    W ("- ROJA {0} state={1} last={2} result={3}" -f $x.TaskName, $x.State, $i.LastRunTime, $i.LastTaskResult)
  }
}
$cmdlines = Get-ChildItem "$env:USERPROFILE\scripts\hidden-tasks" -Filter *.cmdline -ErrorAction SilentlyContinue
$referenced = ($t | ForEach-Object { $_.Actions.Arguments }) -join "`n"
foreach ($c in $cmdlines) { if ($referenced -notmatch [regex]::Escape($c.Name)) { W "- HUERFANO hidden-tasks\$($c.Name) (ninguna schtask lo referencia)" } }

W "`n## Inicio de sesion (Win32_StartupCommand)"
Get-CimInstance Win32_StartupCommand | ForEach-Object { W "- $($_.Name) [$($_.Location)]" }

if ($Out) { $lines | Set-Content -LiteralPath $Out -Encoding utf8; Write-Output "`n(guardado en $Out)" }
