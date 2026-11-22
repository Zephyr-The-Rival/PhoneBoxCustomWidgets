# Clipboard widget helper: Windows' clipboard history (Win+V) for the host, which can't call Windows Runtime APIs
# from Python's standard library. plugin.py keeps one of these running and talks to it over stdin / stdout:
#   list             -> {"enabled": true, "items": [{"id", "kind": "text|image|files|other", "text", "time"}]}  newest first
#   set <id>         -> {"ok": true}  that entry becomes the current clipboard content, as if picked in Win+V
#   current          -> {"files": [paths] | null}  the files on the clipboard right now (Win+V doesn't keep files)
#   setfiles <b64>   -> {"ok": true}  puts these files on the clipboard as a copy (b64: UTF-8 JSON list of paths)
#   thumb <b64>      -> {"ok", "mime", "data": base64}  Explorer's thumbnail of a file or folder (b64: UTF-8 path)
#   image <id>       -> {"ok", "mime", "data": base64}  a small PNG of an image entry in the history
# One JSON line per command. Nothing is written anywhere else. Windows Forms' clipboard needs STA (-STA, the default).
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false

Add-Type -AssemblyName System.Runtime.WindowsRuntime, System.Windows.Forms, System.Drawing
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(10000)
  $task.Result
}
[void][Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.FileProperties.StorageItemThumbnail, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.RandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$CB = [Windows.ApplicationModel.DataTransfer.Clipboard]
$F = [Windows.ApplicationModel.DataTransfer.StandardDataFormats]
$MaxText = 2000   # the tablet shows a preview; pasting uses the whole entry anyway

$items = @{}
function FromB64([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
function StreamBytes($winrtStream) {
  $s = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($winrtStream)
  $ms = New-Object IO.MemoryStream
  $s.CopyTo($ms); $s.Dispose()
  , $ms.ToArray()
}
function Shrink([byte[]]$bytes, [int]$max) {  # any image -> PNG at most $max px wide / high
  $img = [Drawing.Image]::FromStream((New-Object IO.MemoryStream(, $bytes)))
  $scale = [Math]::Min(1.0, $max / [Math]::Max($img.Width, $img.Height))
  $w = [Math]::Max(1, [int]($img.Width * $scale)); $h = [Math]::Max(1, [int]($img.Height * $scale))
  $bmp = New-Object Drawing.Bitmap $w, $h
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $w, $h); $g.Dispose(); $img.Dispose()
  $out = New-Object IO.MemoryStream
  $bmp.Save($out, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  , $out.ToArray()
}
function BmpToPng([byte[]]$b) {
  # Explorer's thumbnails often come as 32-bit BMPs with transparency (icons), which GDI+ would load without the
  # alpha channel (black corners): copy the pixels into an ARGB bitmap by hand. Rows are bottom-up when height > 0.
  $off = [BitConverter]::ToInt32($b, 10); $w = [BitConverter]::ToInt32($b, 18); $h = [BitConverter]::ToInt32($b, 22)
  if ([BitConverter]::ToInt16($b, 28) -ne 32) { return , (Shrink $b 256) }
  $rows = [Math]::Abs($h); $row = $w * 4
  $bmp = New-Object Drawing.Bitmap $w, $rows, ([Drawing.Imaging.PixelFormat]::Format32bppPArgb)
  $lock = $bmp.LockBits((New-Object Drawing.Rectangle 0, 0, $w, $rows), [Drawing.Imaging.ImageLockMode]::WriteOnly,
    [Drawing.Imaging.PixelFormat]::Format32bppPArgb)
  for ($y = 0; $y -lt $rows; $y++) {
    $src = $off + $(if ($h -gt 0) { ($rows - 1 - $y) * $row } else { $y * $row })
    [Runtime.InteropServices.Marshal]::Copy($b, $src, [IntPtr]($lock.Scan0.ToInt64() + $y * $lock.Stride), $row)
  }
  $bmp.UnlockBits($lock)
  $out = New-Object IO.MemoryStream
  $bmp.Save($out, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  , $out.ToArray()
}
function Send($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $cmd, $arg = $line.Trim() -split ' ', 2
    if ($cmd -eq 'list') {
      if (-not $CB::IsHistoryEnabled()) { Send @{ enabled = $false; items = @() }; continue }
      $r = Await ($CB::GetHistoryItemsAsync()) ([Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult])
      if ("$($r.Status)" -ne 'Success') { Send @{ enabled = $true; error = "$($r.Status)"; items = @() }; continue }
      $items = @{}
      $list = foreach ($it in $r.Items) {
        $items[$it.Id] = $it
        $c = $it.Content
        $kind = 'other'; $text = ''
        if ($c.Contains($F::Text)) {
          $kind = 'text'
          $text = [string](Await ($c.GetTextAsync()) ([string]))
          if ($text.Length -gt $MaxText) { $text = $text.Substring(0, $MaxText) }
        } elseif ($c.Contains($F::Bitmap)) { $kind = 'image' }
        elseif ($c.Contains($F::StorageItems)) { $kind = 'files' }
        @{ id = $it.Id; kind = $kind; text = $text; time = $it.Timestamp.ToUnixTimeMilliseconds() }
      }
      Send @{ enabled = $true; items = @($list) }
    } elseif ($cmd -eq 'set') {
      $it = $items[$arg]
      if (-not $it) { Send @{ ok = $false; error = 'That entry is gone' }; continue }
      $status = "$($CB::SetHistoryItemAsContent($it))"
      Send @{ ok = ($status -eq 'Success'); status = $status }
    } elseif ($cmd -eq 'current') {
      if ([Windows.Forms.Clipboard]::ContainsFileDropList()) {
        Send @{ files = @([Windows.Forms.Clipboard]::GetFileDropList()) }
      } else { Send @{ files = $null } }
    } elseif ($cmd -eq 'setfiles') {
      $list = New-Object Collections.Specialized.StringCollection
      foreach ($p in (FromB64 $arg | ConvertFrom-Json)) { [void]$list.Add($p) }
      $data = New-Object Windows.Forms.DataObject
      $data.SetFileDropList($list)
      $data.SetData('Preferred DropEffect', (New-Object IO.MemoryStream(, [byte[]](1, 0, 0, 0))))  # 1: copy, never move
      [Windows.Forms.Clipboard]::SetDataObject($data, $true)
      Send @{ ok = $true }
    } elseif ($cmd -eq 'thumb') {
      $path = FromB64 $arg
      $item = if (Test-Path -LiteralPath $path -PathType Container) {
        Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($path)) ([Windows.Storage.StorageFolder])
      } else {
        Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
      }
      $th = Await ($item.GetThumbnailAsync([Windows.Storage.FileProperties.ThumbnailMode]::SingleItem, 256,
        [Windows.Storage.FileProperties.ThumbnailOptions]::ResizeThumbnail)) ([Windows.Storage.FileProperties.StorageItemThumbnail])
      $bytes = StreamBytes $th
      $mime = "$($th.ContentType)"
      if ($bytes.Length -gt 2 -and $bytes[0] -eq 0x42 -and $bytes[1] -eq 0x4D) { $bytes = BmpToPng $bytes; $mime = 'image/png' }  # "BM"
      Send @{ ok = $true; mime = $mime; data = [Convert]::ToBase64String($bytes) }
    } elseif ($cmd -eq 'image') {
      $it = $items[$arg]
      if (-not $it) { Send @{ ok = $false; error = 'That entry is gone' }; continue }
      $ref = Await ($it.Content.GetBitmapAsync()) ([Windows.Storage.Streams.RandomAccessStreamReference])
      $stream = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      $bytes = Shrink (StreamBytes $stream) 360
      Send @{ ok = $true; mime = 'image/png'; data = [Convert]::ToBase64String($bytes) }
    } else {
      Send @{ error = "unknown command: $cmd" }
    }
  } catch {
    Send @{ error = $_.Exception.Message }
  }
}
