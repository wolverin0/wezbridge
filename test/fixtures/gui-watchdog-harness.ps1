<#
gui-watchdog-harness.ps1 - arnes de test para scripts/gui-watchdog.ps1 (T-0315).
Carga el watchdog como biblioteca (WEZBRIDGE_GUI_WATCHDOG_NO_MAIN=1), reemplaza
las funciones que tocan el sistema (censo de GUIs, reloj, recover, census de
mux) por dobles deterministas, corre el escenario pedido y emite JSON con los
recovers invocados y el log. Lo consume test/gui-watchdog.test.cjs.
Escenarios: young | old | cascade (la cascada del 2026-09-01: 5 pids en 5 min).
#>
param([Parameter(Mandatory = $true)][string]$Scenario)

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:TEMP ('gwd-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$env:WEZBRIDGE_GUI_WATCHDOG_NO_MAIN = '1'
$env:WEZBRIDGE_GUI_WATCHDOG_DIR = $dir
$env:WEZBRIDGE_INTEL_DIR = $dir

. (Join-Path $PSScriptRoot '..\..\scripts\gui-watchdog.ps1')

$script:clock = [datetime]'2026-09-01T22:16:00'
$script:hung = @()
$script:recovers = @()

function Get-Now { return $script:clock }
function Get-HungGuis { return @($script:hung) }
function Get-MuxSplit { return @() }
function Invoke-Recover {
  param($Gui, [string]$RecoverScript)
  $script:recovers += [pscustomobject]@{ pid = $Gui.Id; at = (Get-Now).ToString('HH:mm:ss') }
  return 0
}
function New-Gui {
  param([int]$Id, [int]$AgeSeconds, [string]$Title)
  return [pscustomobject]@{
    Id = $Id
    MainWindowTitle = $Title
    StartTime = (Get-Now).AddSeconds(-1 * $AgeSeconds)
  }
}
function Advance {
  param([int]$Minutes = 1)
  $script:clock = $script:clock.AddMinutes($Minutes)
}
function Tick { $null = Invoke-Watchdog -ConfirmSeconds 0 }

switch ($Scenario) {
  'young' {
    Advance
    $script:hung = @(New-Gui -Id 3000 -AgeSeconds 20 -Title '[1/9] tab')
    Tick
  }
  'old' {
    Advance
    $script:hung = @(New-Gui -Id 3001 -AgeSeconds 900 -Title '[1/9] tab')
    Tick
  }
  'cascade' {
    # 22:17..22:21: cada minuto una GUI nueva (pid nuevo, ~55 s de vida) colgada.
    foreach ($i in 1..5) {
      Advance
      $script:hung = @(New-Gui -Id (1000 + $i) -AgeSeconds 55 -Title '[1/9] Handoff orch-t31-live')
      Tick
    }
    # 11 min despues: la ventana del episodio vencio; un cuelgue nuevo vuelve a recuperarse.
    Advance -Minutes 11
    $script:hung = @(New-Gui -Id 2000 -AgeSeconds 300 -Title '[1/9] Handoff orch-t31-live')
    Tick
  }
  'cutoff-retry' {
    # Cascada (3 strikes 22:17/22:18/22:19, cortes 22:20/22:21) y despues UNA GUI colgada
    # por minuto: a las 22:29 el strike mas viejo cumple 10 min y tiene que haber
    # exactamente un reintento; a las 22:30 y 22:31 los strikes restantes tambien
    # vencen (tanda nueva), y a las 22:32 vuelve el corte.
    foreach ($i in 1..5) {
      Advance
      $script:hung = @(New-Gui -Id (1000 + $i) -AgeSeconds 55 -Title '[1/9] Handoff orch-t31-live')
      Tick
    }
    foreach ($i in 1..11) {
      Advance
      $script:hung = @(New-Gui -Id (3000 + $i) -AgeSeconds 55 -Title '[1/9] Handoff orch-t31-live')
      Tick
    }
  }
  default { throw "escenario desconocido: $Scenario" }
}

$logPath = Join-Path $dir 'gui-watchdog.log'
$log = @()
if (Test-Path -LiteralPath $logPath) { $log = @(Get-Content -LiteralPath $logPath | ForEach-Object { [string]$_ }) }
$eventsPath = Join-Path $dir 'events.jsonl'
$events = @()
if (Test-Path -LiteralPath $eventsPath) { $events = @(Get-Content -LiteralPath $eventsPath | ForEach-Object { [string]$_ }) }
[pscustomobject]@{ recovers = @($script:recovers); log = @($log); events = @($events) } | ConvertTo-Json -Depth 6 -Compress
