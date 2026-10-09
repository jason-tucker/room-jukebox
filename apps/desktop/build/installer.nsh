; Room Jukebox NSIS hooks (included via electron-builder.yml nsis.include).
;
; One-time firewall step: a single elevated PowerShell (one UAC prompt) adds two inbound,
; program-scoped Allow rules. Skipped on silent auto-updates (${isUpdated}) so updates never prompt.
; If UAC is declined the install still succeeds and points at "Fix firewall" in the README.
; Note: no PowerShell variables below, because NSIS would expand "$..." itself.

!macro customInstall
  ${ifNot} ${isUpdated}
    ClearErrors
    ExecShellWait "runas" "powershell.exe" `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Remove-NetFirewallRule -DisplayName 'Room Jukebox (TCP)','Room Jukebox (UDP beacon)' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName 'Room Jukebox (TCP)' -Direction Inbound -Action Allow -Program '$INSTDIR\Room Jukebox.exe' -Protocol TCP -RemoteAddress LocalSubnet,100.64.0.0/10 -Profile Any | Out-Null; New-NetFirewallRule -DisplayName 'Room Jukebox (UDP beacon)' -Direction Inbound -Action Allow -Program '$INSTDIR\Room Jukebox.exe' -Protocol UDP -LocalPort 41234 -RemoteAddress LocalSubnet -Profile Any | Out-Null"` SW_HIDE
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONINFORMATION "Room Jukebox is installed, but the firewall rules were not added, so phones and the other laptop may not reach it. See $\"Fix firewall$\" in the README at github.com/jason-tucker/room-jukebox." /SD IDOK
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ClearErrors
    ExecShellWait "runas" "powershell.exe" `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Remove-NetFirewallRule -DisplayName 'Room Jukebox (TCP)','Room Jukebox (UDP beacon)' -ErrorAction SilentlyContinue"` SW_HIDE
  ${endIf}
!macroend
