@echo off
rem Double-click to install / restart the PhoneBox Widgets host (also after changing a plugin.py).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
