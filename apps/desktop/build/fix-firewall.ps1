<#
.SYNOPSIS
  Room Jukebox "Fix firewall": removes every inbound rule bound to the app executable (including a
  Block rule created by cancelling the Windows Security Alert) and re-adds the two Allow rules.
.DESCRIPTION
  Must run elevated. Run from an elevated PowerShell:
    powershell -NoProfile -ExecutionPolicy Bypass -File "<install dir>\resources\fix-firewall.ps1"
  The installed copy finds the exe next to its resources folder; pass -ProgramPath otherwise.
#>
param(
  [string]$ProgramPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'Room Jukebox.exe'),
  [int]$BeaconPort = 41234
)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error 'Run this script as administrator (elevated PowerShell).'
  exit 1
}
if (-not (Test-Path -LiteralPath $ProgramPath)) {
  Write-Error "Room Jukebox executable not found: $ProgramPath"
  exit 1
}

# Every rule whose program filter is this exe, whatever its name or action.
$existing = Get-NetFirewallApplicationFilter -Program $ProgramPath -ErrorAction SilentlyContinue |
  Get-NetFirewallRule -ErrorAction SilentlyContinue
foreach ($rule in @($existing)) {
  if ($null -eq $rule) { continue }
  Write-Host "Removing rule '$($rule.DisplayName)' ($($rule.Action), $($rule.Direction))"
  Remove-NetFirewallRule -Name $rule.Name
}
Remove-NetFirewallRule -DisplayName 'Room Jukebox (TCP)', 'Room Jukebox (UDP beacon)' -ErrorAction SilentlyContinue

New-NetFirewallRule -DisplayName 'Room Jukebox (TCP)' -Direction Inbound -Action Allow `
  -Program $ProgramPath -Protocol TCP -RemoteAddress LocalSubnet, 100.64.0.0/10 -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'Room Jukebox (UDP beacon)' -Direction Inbound -Action Allow `
  -Program $ProgramPath -Protocol UDP -LocalPort $BeaconPort -RemoteAddress LocalSubnet -Profile Any | Out-Null

Write-Host "Firewall rules for $ProgramPath re-created."
