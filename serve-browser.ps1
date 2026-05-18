param(
    [int]$Port = 8000,
    [switch]$NoOpen
)

$assetDir = Join-Path $PSScriptRoot 'app\src\main\assets'
if (-not (Test-Path $assetDir)) {
    throw "Asset directory not found: $assetDir"
}

$url = "http://127.0.0.1:$Port/clock.html"
Write-Host "Serving Bitcoin Block Clock at $url"
Write-Host "Press Ctrl+C to stop the local web server."

if (-not $NoOpen) {
    Start-Process $url
}

Push-Location $assetDir
try {
    py -m http.server $Port
}
finally {
    Pop-Location
}
