[CmdletBinding()]
param(
  [string]$HiddenTasks = (Join-Path $env:USERPROFILE 'scripts\hidden-tasks'),
  [datetime]$StartAt = (Get-Date).AddMinutes(2),
  [switch]$PlanOnly
)
$ErrorActionPreference = 'Stop'
$taskName = 'wezbridge-decision-relay'
$nodePath = (Get-Command node.exe).Source
$wrapper = Join-Path (Split-Path $HiddenTasks -Parent) 'run-hidden.vbs'
if (!(Test-Path -LiteralPath $wrapper)) { throw "Missing hidden wrapper: $wrapper" }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  throw "$taskName already exists; inspect it before changing a live registration"
}
$cmdline = Join-Path $HiddenTasks "$taskName.cmdline"
if (Test-Path -LiteralPath $cmdline) { throw "Existing command file: $cmdline" }
$command = '"{0}" "{1}" --once --json' -f $nodePath, (Join-Path $PSScriptRoot 'decision-relay.cjs')
[xml]$xml = Export-ScheduledTask -TaskName 'wezbridge-queue-drain'
$xml.Task.RegistrationInfo.URI = "\$taskName"
$xml.Task.RegistrationInfo.Description = 'T-0351: decision relay every 5 minutes; JSON consumed by routine-audit, steward-gate and boards.'
$xml.Task.Actions.Exec.Command = 'wscript.exe'
$xml.Task.Actions.Exec.Arguments = '//B //NoLogo "{0}" "{1}"' -f $wrapper, $cmdline
$xml.Task.Triggers.TimeTrigger.StartBoundary = $StartAt.ToString('yyyy-MM-ddTHH:mm:sszzz')
$xml.Task.Triggers.TimeTrigger.Repetition.Interval = 'PT5M'
$xml.Task.Triggers.TimeTrigger.Repetition.Duration = 'P3650D'
foreach ($setting in @{ Enabled = 'true'; ExecutionTimeLimit = 'PT4M' }.GetEnumerator()) {
  $element = $xml.Task.Settings.SelectSingleNode("*[local-name()='$($setting.Key)']")
  if (!$element) { $element = $xml.CreateElement($setting.Key, $xml.DocumentElement.NamespaceURI); $null = $xml.Task.Settings.AppendChild($element) }
  $element.InnerText = $setting.Value
}
if ($PlanOnly) {
  [pscustomobject]@{ task = $taskName; cmdline = $cmdline; command = $command; xml = $xml.OuterXml } | ConvertTo-Json -Depth 3
  return
}
New-Item -ItemType Directory -Force -Path $HiddenTasks | Out-Null
[IO.File]::WriteAllText($cmdline, $command, [Text.UTF8Encoding]::new($false))
try { Register-ScheduledTask -TaskName $taskName -Xml $xml.OuterXml | Select-Object TaskName, State }
catch { Remove-Item -LiteralPath $cmdline; throw }
# Do not start it here. The first and subsequent executions must be clock-triggered.
