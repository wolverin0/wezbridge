<#
gui-watchdog.ps1 — detecta un wezterm-gui colgado (Responding=False, confirmado
dos veces con 30 s de distancia) y dispara ~/scripts/Recover-WezTermGui.ps1, que
reemplaza el GUI conservando los panes del mux. Tambien avisa si hay mas de un
wezterm-mux-server con panes (sintoma temprano del robo de `sock`).
Corre cada 1 min desde la tarea programada `wezbridge-gui-watchdog`. Log de
eventos (solo eventos, sin heartbeat): %LOCALAPPDATA%\WezTerm\gui-watchdog.log.
Por que existe: 2026-09-01, 4 GUIs colgados en 3 dias; el script de recuperacion
existia y funcionaba pero nadie lo corria. artifacts/2026-09-01-wezterm-gui-hang-diagnosis.html
#>
param(
  [int]$ConfirmSeconds = 30,
  [string]$RecoverScript = (Join-Path $HOME 'scripts\Recover-WezTermGui.ps1'),
  [int]$RetryMinutes = 30,
  [int]$MaxAttemptsPerPid = 2,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$logDir = Join-Path $env:LOCALAPPDATA 'WezTerm'
$logPath = Join-Path $logDir 'gui-watchdog.log'
$statePath = Join-Path $logDir 'gui-watchdog-state.json'

function Write-Log {
  param([string]$Message)
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $logPath -Value $line
  Write-Host $line
}

function Get-HungGuis {
  @(Get-Process -Name 'wezterm-gui' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and -not $_.Responding })
}

function Read-State {
  if (Test-Path -LiteralPath $statePath) {
    try { return (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json) } catch { }
  }
  return [pscustomobject]@{ attempts = [pscustomobject]@{} }
}

function Save-State {
  param($State)
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  ($State | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statePath -Encoding utf8
}

# --- 1. Census de mux-servers con panes: mas de uno = sock robado o por robar.
$all = Get-CimInstance Win32_Process
$muxOwners = @()
foreach ($m in @($all | Where-Object { $_.Name -eq 'wezterm-mux-server.exe' })) {
  $kids = @($all | Where-Object { $_.ParentProcessId -eq $m.ProcessId -and $_.Name -ne 'OpenConsole.exe' })
  if ($kids.Count -gt 0) { $muxOwners += "$($m.ProcessId)x$($kids.Count)" }
}
if ($muxOwners.Count -gt 1) {
  Write-Log ("mux_split owners=" + ($muxOwners -join ','))
}

# --- 2. GUI colgado, confirmado dos veces.
$hung = @(Get-HungGuis)
if ($hung.Count -eq 0) { exit 0 }
Start-Sleep -Seconds $ConfirmSeconds
$stillHungIds = @(Get-HungGuis | Select-Object -ExpandProperty Id)
$confirmed = @($hung | Where-Object { $_.Id -in $stillHungIds })
if ($confirmed.Count -eq 0) { exit 0 }

$state = Read-State
foreach ($gui in $confirmed) {
  $key = [string]$gui.Id
  $prev = $null
  if ($state.attempts.PSObject.Properties[$key]) { $prev = $state.attempts.$key }
  $count = 0; $last = $null
  if ($prev) { $count = [int]$prev.count; $last = [datetime]$prev.last }

  if ($count -ge $MaxAttemptsPerPid) { continue }  # ya se intento; que lo mire una persona
  if ($last -and ((Get-Date) - $last).TotalMinutes -lt $RetryMinutes) { continue }

  Write-Log ("hung_confirmed pid={0} title=""{1}"" attempt={2}" -f $gui.Id, $gui.MainWindowTitle, ($count + 1))
  if ($DryRun) { Write-Log "dry_run: no se llama al recover"; continue }
  if (-not (Test-Path -LiteralPath $RecoverScript)) { Write-Log "recover_missing path=$RecoverScript"; continue }

  $guisBefore = @(Get-Process -Name 'wezterm-gui' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $exit = -1
  try {
    $p = Start-Process -FilePath 'powershell' -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $RecoverScript
    ) -Wait -PassThru -WindowStyle Hidden
    $exit = $p.ExitCode
  } catch { Write-Log ("recover_error " + $_.Exception.Message) }
  Write-Log "recover_exit code=$exit"

  if ($exit -ne 0) {
    # El recover lanza un GUI de reemplazo y, si no puede probar el conteo de
    # tabs, se niega a matar el viejo — pero deja el reemplazo abierto. Un
    # intento fallido cada 30 min acumularia ventanas: cerrar el huerfano.
    $guisAfter = @(Get-Process -Name 'wezterm-gui' -ErrorAction SilentlyContinue)
    foreach ($g in $guisAfter) {
      if ($g.Id -in $guisBefore) { continue }
      if ($g.MainWindowTitle -match '^\[\d+/(\d+)\]' -and [int]$Matches[1] -gt 1) { continue }
      Stop-Process -Id $g.Id -Force -ErrorAction SilentlyContinue
      Write-Log "closed_unproven_replacement pid=$($g.Id)"
    }
  }

  $state.attempts | Add-Member -NotePropertyName $key -NotePropertyValue ([pscustomobject]@{
    count = $count + 1; last = (Get-Date).ToString('o'); exit = $exit
  }) -Force
  Save-State $state
}
