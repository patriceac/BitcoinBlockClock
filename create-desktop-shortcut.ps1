$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$targetPath = Join-Path $repoRoot 'dist\electron\win-unpacked\BitcoinBlockClock.exe'
$iconPath = Join-Path $repoRoot 'electron\assets\bitcoin-logo.ico'

if (-not (Test-Path $targetPath)) {
    throw "Built Electron executable not found at $targetPath"
}

if (-not (Test-Path $iconPath)) {
    throw "Desktop shortcut icon not found at $iconPath"
}

$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'Bitcoin Block Clock.lnk'

$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = Split-Path -Parent $targetPath
$shortcut.IconLocation = $iconPath
$shortcut.Save()

Write-Host "Desktop shortcut created at $shortcutPath"
