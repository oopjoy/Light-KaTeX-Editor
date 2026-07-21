$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'launcher\LightKaTeXEditor.exe'
$icon = Join-Path $root 'launcher\app.ico'

& (Join-Path $PSScriptRoot 'make-launcher.ps1') | Out-Host

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Light KaTeX Editor.lnk'

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($lnk)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 1
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = 'Light KaTeX Editor'
$shortcut.Save()

Write-Output "Desktop shortcut: $lnk"
