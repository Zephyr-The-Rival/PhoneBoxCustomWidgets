@echo off
rem Development mode: stops the background host and runs it in this window with every request logged.
rem widget.js / sdk.js changes need no restart (reload the widget); plugin.py changes: Ctrl+C and run dev.cmd again.
rem Close this window and run install.cmd to go back to the normal background host.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }"
set PBW_DEBUG=1
python "%~dp0host\server.py"
pause
