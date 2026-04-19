' Solomon's Key — Windows launcher (VBScript).
' Copy this file to your Desktop. Double-click to:
'   1. Boot the WSL-side orchestrator via start.sh (silent, no console flash)
'   2. Open the dashboard in the default browser
'
' Target WSL distro below must match your installation. Change if needed.

Option Explicit

Dim shell, wslDistro, cmd

Set shell = CreateObject("WScript.Shell")

wslDistro = "Ubuntu-22.04"
cmd = "wsl.exe -d " & wslDistro & " -- bash -lc ""cd ~/solomons-key && ./start.sh"""

' Run WSL command silently (window style 0 = hidden, wait = false)
shell.Run cmd, 0, False

' Give the services a moment, then open the dashboard
WScript.Sleep 2500
shell.Run "http://127.0.0.1:3000", 1, False

Set shell = Nothing
