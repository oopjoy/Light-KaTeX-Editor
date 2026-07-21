# Multi-resolution app icon — one visual language for all sizes.
# Matches the crisp small-icon look (solid blue tile + white geometric K)
# and scales the same design up for 32–256 instead of a different gradient style.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outIco = Join-Path $root 'launcher\app.ico'
$outPng = Join-Path $root 'launcher\app-256.png'
$buildIco = Join-Path $root 'build\icon.ico'
$buildPng = Join-Path $root 'build\icon.png'
New-Item -ItemType Directory -Force -Path (Split-Path $outIco) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $buildIco) | Out-Null

# Same blue as small icons / titlebar
$script:Blue = [System.Drawing.Color]::FromArgb(255, 37, 99, 235) # #2563eb

function New-AppBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)

  $isTiny = $size -le 24
  if ($isTiny) {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighSpeed
  } else {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  }

  # Tile: same solid blue family; tiny = full square, larger = mild rounded corners
  $brush = New-Object System.Drawing.SolidBrush $script:Blue
  if ($isTiny) {
    $m = 1
    $g.FillRectangle($brush, $m, $m, $size - 2 * $m, $size - 2 * $m)
  } else {
    $m = [Math]::Max(1.0, $size * 0.04)
    $radius = [Math]::Max(2.0, $size * 0.16)
    $rect = New-Object System.Drawing.RectangleF $m, $m, ($size - 2 * $m), ($size - 2 * $m)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = [float]($radius * 2)
    $x = $rect.X; $y = $rect.Y; $w = $rect.Width; $h = $rect.Height
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
    $path.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
    $path.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($brush, $path)
    $path.Dispose()
  }
  $brush.Dispose()

  # White K — same proportions at every size (stem left, arms from mid)
  $white = [System.Drawing.Color]::White
  if ($isTiny) {
    Draw-TinyK $g $size $white
  } else {
    Draw-LargeK $g $size $white
  }

  $g.Dispose()
  return $bmp
}

function Draw-TinyK(
  [System.Drawing.Graphics]$g,
  [int]$size,
  [System.Drawing.Color]$white
) {
  $wbrush = New-Object System.Drawing.SolidBrush $white
  if ($size -eq 16) {
    $g.FillRectangle($wbrush, 4, 3, 2, 10)
    $g.FillRectangle($wbrush, 6, 5, 1, 2)
    $g.FillRectangle($wbrush, 7, 4, 1, 2)
    $g.FillRectangle($wbrush, 8, 3, 2, 2)
    $g.FillRectangle($wbrush, 10, 3, 1, 1)
    $g.FillRectangle($wbrush, 6, 8, 1, 2)
    $g.FillRectangle($wbrush, 7, 9, 1, 2)
    $g.FillRectangle($wbrush, 8, 10, 2, 2)
    $g.FillRectangle($wbrush, 10, 12, 1, 1)
  } elseif ($size -eq 20) {
    $g.FillRectangle($wbrush, 5, 4, 2, 12)
    $g.FillRectangle($wbrush, 7, 7, 1, 2)
    $g.FillRectangle($wbrush, 8, 6, 1, 2)
    $g.FillRectangle($wbrush, 9, 5, 1, 2)
    $g.FillRectangle($wbrush, 10, 4, 3, 2)
    $g.FillRectangle($wbrush, 7, 10, 1, 2)
    $g.FillRectangle($wbrush, 8, 11, 1, 2)
    $g.FillRectangle($wbrush, 9, 12, 1, 2)
    $g.FillRectangle($wbrush, 10, 13, 3, 2)
  } else {
    # 24
    $g.FillRectangle($wbrush, 6, 5, 3, 14)
    $g.FillRectangle($wbrush, 9, 9, 1, 2)
    $g.FillRectangle($wbrush, 10, 8, 1, 2)
    $g.FillRectangle($wbrush, 11, 7, 1, 2)
    $g.FillRectangle($wbrush, 12, 6, 1, 2)
    $g.FillRectangle($wbrush, 13, 5, 4, 2)
    $g.FillRectangle($wbrush, 9, 12, 1, 2)
    $g.FillRectangle($wbrush, 10, 13, 1, 2)
    $g.FillRectangle($wbrush, 11, 14, 1, 2)
    $g.FillRectangle($wbrush, 12, 15, 1, 2)
    $g.FillRectangle($wbrush, 13, 16, 4, 2)
  }
  $wbrush.Dispose()
}

function Draw-LargeK(
  [System.Drawing.Graphics]$g,
  [int]$size,
  [System.Drawing.Color]$white
) {
  # Match tiny-icon geometry in relative units (from 16px reference):
  #   stem ~ left 0.28, width ~0.125, top 0.19, bottom 0.81
  #   arms join at mid ~0.50, outer tips ~0.69 x
  $left = $size * 0.28
  $stemW = [Math]::Max(2.0, $size * 0.125)
  $top = $size * 0.19
  $bot = $size * 0.81
  $midY = $size * 0.50
  $right = $size * 0.69

  $penW = [Math]::Max(2.0, $size * 0.125)
  $pen = New-Object System.Drawing.Pen $white, $penW
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  $stemX = $left + $stemW * 0.5
  $g.DrawLine($pen, $stemX, $top, $stemX, $bot)
  $g.DrawLine($pen, $stemX, $midY, $right, $top)
  $g.DrawLine($pen, $stemX, $midY, $right, $bot)
  $pen.Dispose()
}

function Save-Ico([string]$path, [System.Drawing.Bitmap[]]$images) {
  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Create)
  $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([UInt16]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]$images.Count)

  $offset = 6 + (16 * $images.Count)
  $pngBlobs = New-Object System.Collections.Generic.List[byte[]]

  foreach ($img in $images) {
    $ms = New-Object System.IO.MemoryStream
    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    $pngBlobs.Add($bytes) | Out-Null

    $w = if ($img.Width -ge 256) { 0 } else { [byte]$img.Width }
    $h = if ($img.Height -ge 256) { 0 } else { [byte]$img.Height }
    $bw.Write([byte]$w)
    $bw.Write([byte]$h)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $bytes.Length
  }
  foreach ($blob in $pngBlobs) { $bw.Write($blob) }
  $bw.Flush()
  $fs.Close()
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
$images = @()
foreach ($s in $sizes) {
  $images += ,(New-AppBitmap $s)
}

$preview = New-AppBitmap 256
$preview.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Save($buildPng, [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose()

Save-Ico $outIco $images
Copy-Item -Force $outIco $buildIco

foreach ($img in $images) { $img.Dispose() }

Write-Output "Icon written: $outIco ($($sizes -join ', ') px) — unified solid-blue K style"
Write-Output "Also: $buildIco"
Write-Output "Preview: $outPng"
