# Stops the PhoneBox Widgets host and removes its autostart. Your widget settings stay in
# %APPDATA%\PhoneBoxWidgets (delete that folder to remove them too).
$startup = [Environment]::GetFolderPath('Startup')
foreach ($name in 'PhoneBox Widgets.lnk', 'PhoneBox Volume Slider.lnk') {
    $lnk = Join-Path $startup $name
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "Removed $lnk" }
}
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'PhoneBox Widgets.lnk'
if (Test-Path $menu) { Remove-Item $menu -Force; Write-Host "Removed $menu" }
$procs = Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $procs) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; Write-Host "Stopped the host (pid $procId)" }
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { $adb = (Get-Command adb.exe -ErrorAction SilentlyContinue).Source }
if ($adb) { & $adb reverse --remove tcp:8766 2>$null | Out-Null }
Write-Host 'Done.'
