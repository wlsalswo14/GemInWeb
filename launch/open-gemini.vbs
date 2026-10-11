' Runs open-gemini.ps1 with no console window.
' wscript.exe is a GUI host, so Run(..., 0, False) stays invisible; powershell.exe
' -WindowStyle Hidden alone still flashes a window (Windows 11 hands it to Windows Terminal).
Option Explicit
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\open-gemini.ps1""", 0, False