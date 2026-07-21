$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcherDir = Join-Path $root 'launcher'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$src = Join-Path $PSScriptRoot 'LightKaTeXEditorLauncher.cs'
$icon = Join-Path $launcherDir 'app.ico'
$exe = Join-Path $launcherDir 'LightKaTeXEditor.exe'
$lnkPath = Join-Path $launcherDir 'Light KaTeX Editor.lnk'
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'

New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null

if (-not (Test-Path $electron)) {
  throw "Electron binary not found: $electron"
}
if (-not (Test-Path $csc)) {
  throw "C# compiler not found: $csc"
}

# Icon
& (Join-Path $PSScriptRoot 'make-icon.ps1') | Out-Host

if (-not (Test-Path $icon)) {
  throw "Icon missing after make-icon.ps1: $icon"
}

# Compile named launcher EXE (so Open-with shows "Light KaTeX Editor", not Script Host)
$refs = @(
  '/r:System.dll',
  '/r:System.Windows.Forms.dll',
  '/r:System.Drawing.dll'
)
& $csc /nologo /target:winexe /platform:anycpu /win32icon:"$icon" /out:"$exe" @refs "$src"
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit $LASTEXITCODE" }

# Shortcut next to launcher
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($lnkPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 1
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = 'Light KaTeX Editor'
$shortcut.Save()

Write-Output "Launcher written:"
Write-Output "  $exe"
Write-Output "  $lnkPath"
Write-Output "  $icon"
