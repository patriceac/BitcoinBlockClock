param([ValidateSet('down', 'up')][string]$Direction = 'down')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\electron\assets'))
$assetName = if ($Direction -eq 'up') { 'bitcoin-alert-up' } else { 'bitcoin-alert' }
$source = [Drawing.Image]::FromFile((Join-Path $assetDirectory 'bitcoin-logo.png'))
$white = [Drawing.SolidBrush]::new([Drawing.Color]::White)
$color = if ($Direction -eq 'up') { [Drawing.Color]::FromArgb(255, 34, 197, 94) } else { [Drawing.Color]::FromArgb(255, 239, 39, 59) }
$badge = [Drawing.SolidBrush]::new($color)
$frames = @()
try {
    foreach ($size in @(16, 20, 24, 32, 48, 64, 128, 256)) {
        $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $stream = [IO.MemoryStream]::new()
        try {
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $graphics.DrawImage($source, [Drawing.Rectangle]::new(0, 0, $size, $size))
            # A white ring separates the dot from the logo and both tray themes.
            $graphics.FillEllipse($white, [single]($size * .54), [single]($size * .54), [single]($size * .44), [single]($size * .44))
            $graphics.FillEllipse($badge, [single]($size * .595), [single]($size * .595), [single]($size * .33), [single]($size * .33))
            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            $frames += @{ Size = $size; Bytes = $stream.ToArray() }
            if ($size -eq 256) { $bitmap.Save((Join-Path $assetDirectory "$assetName.png"), [Drawing.Imaging.ImageFormat]::Png) }
        } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
    }
    $file = [IO.File]::Create((Join-Path $assetDirectory "$assetName.ico"))
    $writer = [IO.BinaryWriter]::new($file)
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
        $offset = 6 + 16 * $frames.Count
        foreach ($frame in $frames) {
            $dimension = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
            $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
            $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$frame.Bytes.Length); $writer.Write([uint32]$offset)
            $offset += $frame.Bytes.Length
        }
        foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
    } finally { $writer.Dispose(); $file.Dispose() }
} finally { $source.Dispose(); $white.Dispose(); $badge.Dispose() }
