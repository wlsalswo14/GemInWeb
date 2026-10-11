@echo off
rem Double-click helper: runs uninstall.ps1 (extra args are passed through, e.g. -Purge, -DryRun).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
echo.
pause
