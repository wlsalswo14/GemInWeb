@echo off
rem Double-click helper: runs install.ps1 (extra args are passed through, e.g. -DryRun).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
