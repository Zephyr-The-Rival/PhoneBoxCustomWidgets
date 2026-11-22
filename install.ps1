# Installs (or restarts) the PhoneBox Widgets host: starts it now and with every Windows sign-in.
# Double-click install.cmd, or run:  powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$server = Join-Path $PSScriptRoot 'host\server.py'
if (-not (Test-Path $server)) { throw "host\server.py not found next to install.ps1" }

# pythonw runs without a console window
$pythonw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pythonw) {
    $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if ($python) { $pythonw = Join-Path (Split-Path $python) 'pythonw.exe' }
}
if (-not $pythonw -or -not (Test-Path $pythonw)) { throw 'Python 3 (pythonw.exe) was not found. Install Python from python.org and run this again.' }

$startup = [Environment]::GetFolderPath('Startup')
# the Volume Slider's own autostart from before the host existed
$old = Join-Path $startup 'PhoneBox Volume Slider.lnk'
if (Test-Path $old) { Remove-Item $old -Force; Write-Host 'Removed the old Volume Slider autostart (the host replaces it)' }

$lnk = Join-Path $startup 'PhoneBox Widgets.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = $pythonw
$s.Arguments = '"' + $server + '"'
$s.WorkingDirectory = Split-Path $server
$s.Description = 'PhoneBox Widgets host'
$s.Save()
Write-Host "Autostart: $lnk"

# Start Menu entry: opens the setup page (and starts the host if it isn't running). Search "widgets", or pin it.
$programs = [Environment]::GetFolderPath('Programs')
$menu = $shell.CreateShortcut((Join-Path $programs 'PhoneBox Widgets.lnk'))
$menu.TargetPath = $pythonw
$menu.Arguments = '"' + (Join-Path $PSScriptRoot 'host\open.pyw') + '"'
$menu.WorkingDirectory = Join-Path $PSScriptRoot 'host'
$menu.Description = 'Set up your PhoneBox widgets'
$pbIcon = Join-Path $env:LOCALAPPDATA 'PhoneBox\app\PhoneBoxAgent.exe'
if (Test-Path $pbIcon) { $menu.IconLocation = "$pbIcon,0" }
$menu.Save()
Write-Host "Start Menu: PhoneBox Widgets (opens the setup page)"

# stop whatever serves port 8766 now (an older host, the old Volume Slider bridge, dev.cmd)
$running = Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $running) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 300
Start-Process -FilePath $pythonw -ArgumentList ('"' + $server + '"') -WorkingDirectory (Split-Path $server) -WindowStyle Hidden

$ok = $false
for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 250
    try { Invoke-RestMethod 'http://127.0.0.1:8766/api/ping' -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { }
}
if ($ok) {
    $types = (Invoke-RestMethod 'http://127.0.0.1:8766/api/types').types | ForEach-Object { $_.name }
    Write-Host ("Host running on http://127.0.0.1:8766 with: " + ($types -join ', ')) -ForegroundColor Green
    if ($args -notcontains '-NoBrowser') { Start-Process 'http://127.0.0.1:8766/' }
} else {
    Write-Warning "The host did not answer. See $env:APPDATA\PhoneBoxWidgets\host.log (or run dev.cmd to see errors)."
}
