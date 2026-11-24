# Draws the PhoneBox Widgets icon (a tablet with four widget tiles in the widgets' colors) and saves it as
# host\launcher\PhoneBoxWidgets.ico (PNG images at 16-256 px in one .ico). The .ico is in the repository; run this
# again only to change the design:  powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\host\launcher\PhoneBoxWidgets.ico'

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Min($r * 2, [Math]::Min($w, $h))
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure(); $p
}
function Color([string]$hex) { [Drawing.ColorTranslator]::FromHtml($hex) }

function Draw([int]$s) {
  $bmp = New-Object Drawing.Bitmap $s, $s, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([Drawing.Color]::Transparent)
  # the tablet (landscape), dark with a teal rim
  $line = [Math]::Max(1.0, $s * 0.055)
  $tx = $s * 0.04 + $line / 2; $ty = $s * 0.15 + $line / 2; $tw = $s * 0.92 - $line; $th = $s * 0.70 - $line
  $body = RoundRect $tx $ty $tw $th ($s * 0.13)
  $g.FillPath((New-Object Drawing.SolidBrush (Color '#0f141b')), $body)
  $g.DrawPath((New-Object Drawing.Pen (Color '#2dd4bf'), $line), $body)
  # four widget tiles in the widgets' accent colors
  $pad = $s * 0.13; $gap = [Math]::Max(1.0, $s * 0.055)
  $ix = $tx + $pad * 0.85; $iy = $ty + $pad * 0.75; $iw = $tw - 2 * $pad * 0.85; $ih = $th - 2 * $pad * 0.75
  $cw = ($iw - $gap) / 2; $ch = ($ih - $gap) / 2
  $colors = '#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6'
  for ($i = 0; $i -lt 4; $i++) {
    $cx = $ix + ($i % 2) * ($cw + $gap); $cy = $iy + [Math]::Floor($i / 2) * ($ch + $gap)
    $g.FillPath((New-Object Drawing.SolidBrush (Color $colors[$i])), (RoundRect $cx $cy $cw $ch ($s * 0.05)))
  }
  $g.Dispose()
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  , $ms.ToArray()
}

# .ico: a header, one 16-byte entry per size, then the PNG images
$sizes = 16, 24, 32, 48, 64, 256
$images = foreach ($s in $sizes) { , (Draw $s) }
$f = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $f
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$images[$i].Length); $w.Write([uint32]$offset)
  $offset += $images[$i].Length
}
foreach ($img in $images) { $w.Write($img) }
$w.Flush()
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
[IO.File]::WriteAllBytes((Resolve-Path (Split-Path $out)).Path + '\' + (Split-Path $out -Leaf), $f.ToArray())
Write-Host "Saved $out"
