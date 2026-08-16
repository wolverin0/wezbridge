# install-task.ps1 - registers the wezbridge-fleet-board scheduled task
# (T-0140 stage-4 rule: Task-Scheduler-hosted from day one).
#   Triggers: at logon + every 1 minute (repetition = restart-on-death loop,
#             same convention as WarehouseVisionKitchenWatcher).
#   Action:   the idempotent launcher; a live server makes it a no-op.
[CmdletBinding()]
param([switch]$Uninstall)

$name = "wezbridge-fleet-board"
if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Output "uninstalled $name"
    return
}

$launcher = Join-Path (Split-Path -Parent $PSCommandPath) "start-board-server.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $launcher) `
    -WorkingDirectory (Split-Path -Parent $PSCommandPath)

$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# 3650 days: Task Scheduler's XML rejects [TimeSpan]::MaxValue; ten years is
# operationally "indefinite" for a repetition window.
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $repeat) `
    -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "installed + started $name (logon + 1-min repetition)"
