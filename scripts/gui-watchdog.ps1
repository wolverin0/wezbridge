<#
gui-watchdog.ps1 - detecta un wezterm-gui colgado (Responding=False, confirmado
dos veces con 30 s de distancia) y dispara ~/scripts/Recover-WezTermGui.ps1, que
reemplaza el GUI conservando los panes del mux. Tambien avisa si hay mas de un
wezterm-mux-server con panes (sintoma temprano del robo de `sock`).
Corre cada 1 min desde la tarea programada `wezbridge-gui-watchdog`. Log de
eventos (solo eventos, sin heartbeat): %LOCALAPPDATA%\WezTerm\gui-watchdog.log.
Por que existe: 2026-09-01, 4 GUIs colgados en 3 dias; el script de recuperacion
existia y funcionaba pero nadie lo corria. artifacts/2026-09-01-wezterm-gui-hang-diagnosis.html
T-0315 (2026-09-05): 3-strike por EPISODIO (ventana EpisodeMinutes: dos recovers por
ventana, el tercer cuelgue se corta y se reintenta al vencer el strike mas viejo) ademas del tope
por pid - la cascada del 01/09 (5 pids en 5 min) nunca acumulaba 3 por pid porque
cada reemplazo estrena pid. Cada hung_confirmed registra edad de la GUI + tab; una
GUI de < YoungGuiSeconds se marca young_gui_hung (solo registro, se recupera igual:
la hipotesis "arranque lento" quedo refutada, 0,9-1,5 s medidos).
Tests: test/gui-watchdog.test.cjs via test/fixtures/gui-watchdog-harness.ps1 (carga
este archivo con WEZBRIDGE_GUI_WATCHDOG_NO_MAIN=1 y reemplaza Get-HungGuis /
Get-Now / Invoke-Recover / Get-MuxSplit).
#>
param(
  [int]$ConfirmSeconds = 30,
  [string]$RecoverScript = (Join-Path $HOME 'scripts\Recover-WezTermGui.ps1'),
  [int]$RetryMinutes = 30,
  [int]$MaxAttemptsPerPid = 2,
  [int]$EpisodeMinutes = 10,
  [int]$MaxStrikesPerEpisode = 3,
  [int]$YoungGuiSeconds = 60,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:WEZBRIDGE_GUI_WATCHDOG_DIR) { $logDir = $env:WEZBRIDGE_GUI_WATCHDOG_DIR }
else { $logDir = Join-Path $env:LOCALAPPDATA 'WezTerm' }
$logPath = Join-Path $logDir 'gui-watchdog.log'
$statePath = Join-Path $logDir 'gui-watchdog-state.json'
if ($env:WEZBRIDGE_INTEL_DIR) { $intelDir = $env:WEZBRIDGE_INTEL_DIR }
else { $intelDir = Join-Path $PSScriptRoot '..\..\_intel' }

function Get-Now { return Get-Date }

function Write-Log {
  param([string]$Message)
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $line = '{0} {1}' -f (Get-Now).ToString('yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $logPath -Value $line
  Write-Host $line
}

# Aviso consumible por el daemon/digest: una linea en _intel/events.jsonl. Fail-soft.
function Write-Event {
  param([hashtable]$Fields)
  try {
    New-Item -ItemType Directory -Path $intelDir -Force | Out-Null
    $Fields['ts'] = (Get-Now).ToUniversalTime().ToString('o')
    $Fields['source'] = 'gui-watchdog'
    Add-Content -LiteralPath (Join-Path $intelDir 'events.jsonl') -Value (($Fields | ConvertTo-Json -Compress -Depth 4))
  } catch { }
}

function Get-HungGuis {
  @(Get-Process -Name 'wezterm-gui' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and -not $_.Responding })
}

# Census de mux-servers con panes: mas de uno = sock robado o por robar.
function Get-MuxSplit {
  $all = Get-CimInstance Win32_Process
  $owners = @()
  foreach ($m in @($all | Where-Object { $_.Name -eq 'wezterm-mux-server.exe' })) {
    $kids = @($all | Where-Object { $_.ParentProcessId -eq $m.ProcessId -and $_.Name -ne 'OpenConsole.exe' })
    if ($kids.Count -gt 0) { $owners += "$($m.ProcessId)x$($kids.Count)" }
  }
  return @($owners)
}

function Get-GuiAgeSeconds {
  param($Gui)
  try { return [int][math]::Floor(((Get-Now) - $Gui.StartTime).TotalSeconds) } catch { return -1 }
}

function Read-State {
  if (Test-Path -LiteralPath $statePath) {
    try { $s = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $s = $null }
    if ($s) {
      if (-not $s.PSObject.Properties['attempts']) { $s | Add-Member -NotePropertyName attempts -NotePropertyValue ([pscustomobject]@{}) }
      if (-not $s.PSObject.Properties['episode']) { $s | Add-Member -NotePropertyName episode -NotePropertyValue ([pscustomobject]@{ strikes = @(); alerted = $false }) }
      return $s
    }
  }
  return [pscustomobject]@{ attempts = [pscustomobject]@{}; episode = [pscustomobject]@{ strikes = @(); alerted = $false } }
}

function Save-State {
  param($State)
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  ($State | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statePath -Encoding utf8
}

# Corre el recover y devuelve su exit code; cierra el reemplazo huerfano si fallo.
function Invoke-Recover {
  param($Gui, [string]$RecoverScript)
  $guisBefore = @(Get-Process -Name 'wezterm-gui' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $exit = -1
  try {
    # NO usar `Start-Process -Wait`: espera al arbol entero de procesos, y el
    # GUI de reemplazo que lanza el recover es hijo suyo - el watchdog quedaba
    # colgado mientras viviera ese GUI (medido en la primera corrida real,
    # 2026-09-01 18:22, y por eso nunca cerro el reemplazo huerfano).
    $p = Start-Process -FilePath 'powershell' -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $RecoverScript
    ) -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(120000)) {
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      Write-Log "recover_timeout pid=$($p.Id)"
    } else {
      $exit = $p.ExitCode
    }
  } catch { Write-Log ("recover_error " + $_.Exception.Message) }

  if ($exit -ne 0) {
    # El recover lanza un GUI de reemplazo y, si no puede probar el conteo de
    # tabs, se niega a matar el viejo - pero deja el reemplazo abierto. Un
    # intento fallido cada 30 min acumularia ventanas: cerrar el huerfano.
    $guisAfter = @(Get-Process -Name 'wezterm-gui' -ErrorAction SilentlyContinue)
    foreach ($g in $guisAfter) {
      if ($g.Id -in $guisBefore) { continue }
      if ($g.MainWindowTitle -match '^\[\d+/(\d+)\]' -and [int]$Matches[1] -gt 1) { continue }
      Stop-Process -Id $g.Id -Force -ErrorAction SilentlyContinue
      Write-Log "closed_unproven_replacement pid=$($g.Id)"
    }
  }
  return $exit
}

function Invoke-Watchdog {
  param(
    [int]$ConfirmSeconds = $script:ConfirmSeconds,
    [string]$RecoverScript = $script:RecoverScript,
    [int]$RetryMinutes = $script:RetryMinutes,
    [int]$MaxAttemptsPerPid = $script:MaxAttemptsPerPid,
    [int]$EpisodeMinutes = $script:EpisodeMinutes,
    [int]$MaxStrikesPerEpisode = $script:MaxStrikesPerEpisode,
    [int]$YoungGuiSeconds = $script:YoungGuiSeconds,
    [switch]$DryRun = $script:DryRun
  )

  # --- 1. Mux split.
  $muxOwners = @(Get-MuxSplit)
  if ($muxOwners.Count -gt 1) {
    Write-Log ("mux_split owners=" + ($muxOwners -join ','))
  }

  # --- 2. GUI colgado, confirmado dos veces.
  $hung = @(Get-HungGuis)
  if ($hung.Count -eq 0) { return 0 }
  if ($ConfirmSeconds -gt 0) { Start-Sleep -Seconds $ConfirmSeconds }
  $stillHungIds = @(Get-HungGuis | Select-Object -ExpandProperty Id)
  $confirmed = @($hung | Where-Object { $_.Id -in $stillHungIds })
  if ($confirmed.Count -eq 0) { return 0 }

  $state = Read-State
  foreach ($gui in $confirmed) {
    $key = [string]$gui.Id
    $prev = $null
    if ($state.attempts.PSObject.Properties[$key]) { $prev = $state.attempts.$key }
    $count = 0; $last = $null
    if ($prev) { $count = [int]$prev.count; $last = [datetime]$prev.last }

    if ($count -ge $MaxAttemptsPerPid) { continue }  # ya se intento; que lo mire una persona
    if ($last -and ((Get-Now) - $last).TotalMinutes -lt $RetryMinutes) { continue }

    # AC2: edad + tab en cada confirmacion. young_gui_hung es SOLO registro: la
    # GUI joven se recupera igual (el arranque real mide 0,9-1,5 s; una GUI que
    # lleva 55 s adjunta y no responde esta colgada, no arrancando).
    $age = Get-GuiAgeSeconds -Gui $gui
    Write-Log ("hung_confirmed pid={0} age_s={1} title=""{2}"" attempt={3}" -f $gui.Id, $age, $gui.MainWindowTitle, ($count + 1))
    if ($age -ge 0 -and $age -lt $YoungGuiSeconds) {
      Write-Log ("young_gui_hung pid={0} age_s={1} (la GUI tenia menos de {2} s; se recupera igual, el dato es para atrapar el disparador)" -f $gui.Id, $age, $YoungGuiSeconds)
    }

    # AC3: 3-strike por EPISODIO. Los strikes son cuelgues confirmados dentro de
    # la ventana, sin importar el pid: el reemplazo estrena pid y por eso el tope
    # por pid nunca corto la cascada del 01/09. Al tercero no se recupera: si la
    # GUI nueva se cuelga igual, el disparador persiste y reemplazarla solo lo
    # repite (cuatro minutos de flota ciega por la renumeracion del socket gui).
    $now = Get-Now
    $strikes = @()
    foreach ($s in @($state.episode.strikes)) {
      try { if (($now - [datetime]$s).TotalMinutes -lt $EpisodeMinutes) { $strikes += $s } } catch { }
    }
    if ($strikes.Count -eq 0) { $state.episode.alerted = $false }  # ventana vencida: episodio nuevo
    # Los strikes son RECOVERS lanzados dentro de la ventana. Con Max=3, el
    # tercer cuelgue confirmado (dos recovers ya hechos) es el que se corta.
    if (($strikes.Count + 1) -ge $MaxStrikesPerEpisode) {
      # En corte NO se suma strike: los que hay envejecen y, vencida la ventana,
      # el watchdog vuelve a intentar UNA tanda. Medido 2026-09-05 23:14-23:20:
      # sumando strike por minuto la ventana nunca vencia y la GUI quedaba
      # colgada para siempre con el operador delante.
      $oldest = [datetime]$strikes[0]
      $retryAt = $oldest.AddMinutes($EpisodeMinutes).ToString('HH:mm:ss')
      Write-Log ("episode_cutoff strike={0}/{1} window_min={2} pid={3} age_s={4} retry_at={5} - no se recupera: {1} cuelgues en la ventana = el disparador persiste y reemplazar la GUI solo lo repite (cascada 2026-09-01)" -f ($strikes.Count + 1), $MaxStrikesPerEpisode, $EpisodeMinutes, $gui.Id, $age, $retryAt)
      if (-not $state.episode.alerted) {
        Write-Event @{ event = 'gui-watchdog.episode_cutoff'; strikes = ($strikes.Count + 1); window_min = $EpisodeMinutes; pid = $gui.Id; title = [string]$gui.MainWindowTitle }
        $state.episode.alerted = $true
      }
      $state.episode.strikes = @($strikes)
      Save-State $state
      continue
    }
    $state.episode.strikes = @($strikes)
    Save-State $state

    if ($DryRun) { Write-Log "dry_run: no se llama al recover"; continue }
    if (-not (Test-Path -LiteralPath $RecoverScript)) { Write-Log "recover_missing path=$RecoverScript"; continue }

    $strikes += $now.ToString('o')
    $state.episode.strikes = @($strikes)
    Save-State $state

    $exit = Invoke-Recover -Gui $gui -RecoverScript $RecoverScript
    Write-Log "recover_exit code=$exit"

    $state.attempts | Add-Member -NotePropertyName $key -NotePropertyValue ([pscustomobject]@{
      count = $count + 1; last = (Get-Now).ToString('o'); exit = $exit
    }) -Force
    Save-State $state
  }
  return 0
}

if (-not $env:WEZBRIDGE_GUI_WATCHDOG_NO_MAIN) {
  exit (Invoke-Watchdog -ConfirmSeconds $ConfirmSeconds -RecoverScript $RecoverScript -RetryMinutes $RetryMinutes -MaxAttemptsPerPid $MaxAttemptsPerPid -EpisodeMinutes $EpisodeMinutes -MaxStrikesPerEpisode $MaxStrikesPerEpisode -YoungGuiSeconds $YoungGuiSeconds -DryRun:$DryRun)
}
