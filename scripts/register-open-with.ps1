# Register Light KaTeX Editor in Windows "Open with" for Markdown files (current user).
# Uses a real .exe launcher so the Open-with list shows a proper name + icon.
# Does NOT change the default app.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'launcher\LightKaTeXEditor.exe'
$icon = Join-Path $root 'launcher\app.ico'
$appName = 'Light KaTeX Editor'
$progId = 'LightKaTeXEditor.md'
$extensionConfigPath = Join-Path $root 'config\markdown-extensions.json'
$extensionConfig = Get-Content -Raw -Path $extensionConfigPath | ConvertFrom-Json
$exts = @($extensionConfig.extensions | ForEach-Object { ".$_" })
$appKeyName = 'LightKaTeXEditor.exe'

# Ensure launcher + icon exist
& (Join-Path $PSScriptRoot 'make-launcher.ps1') | Out-Host

if (-not (Test-Path $exe)) { throw "Launcher EXE missing: $exe" }
if (-not (Test-Path $icon)) { throw "Icon missing: $icon" }

$command = '"' + $exe + '" "%1"'
$iconSpec = $icon + ',0'

# Remove old VBS-based registration if present
Remove-Item -Path 'HKCU:\Software\Classes\Applications\LightKaTeXEditor.vbs' -Recurse -Force -ErrorAction SilentlyContinue

# ProgID
New-Item -Path "HKCU:\Software\Classes\$progId" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\$progId" -Name '(default)' -Value $appName
New-Item -Path "HKCU:\Software\Classes\$progId\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\$progId\DefaultIcon" -Name '(default)' -Value $iconSpec
New-Item -Path "HKCU:\Software\Classes\$progId\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\$progId\shell\open\command" -Name '(default)' -Value $command
New-Item -Path "HKCU:\Software\Classes\$progId\Application" -Force | Out-Null
New-ItemProperty -Path "HKCU:\Software\Classes\$progId\Application" -Name 'ApplicationName' -PropertyType String -Value $appName -Force | Out-Null
New-ItemProperty -Path "HKCU:\Software\Classes\$progId\Application" -Name 'ApplicationIcon' -PropertyType String -Value $iconSpec -Force | Out-Null

foreach ($ext in $exts) {
  $ow = "HKCU:\Software\Classes\$ext\OpenWithProgids"
  New-Item -Path $ow -Force | Out-Null
  New-ItemProperty -Path $ow -Name $progId -PropertyType None -Value ([byte[]]@()) -Force | Out-Null

  $fe = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\OpenWithProgids"
  New-Item -Path $fe -Force | Out-Null
  New-ItemProperty -Path $fe -Name $progId -PropertyType None -Value ([byte[]]@()) -Force | Out-Null
}

# Applications registration (Open with dialog)
$appKey = "HKCU:\Software\Classes\Applications\$appKeyName"
New-Item -Path $appKey -Force | Out-Null
Set-ItemProperty -Path $appKey -Name 'FriendlyAppName' -Value $appName
New-Item -Path "$appKey\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$appKey\DefaultIcon" -Name '(default)' -Value $iconSpec
New-Item -Path "$appKey\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$appKey\shell\open\command" -Name '(default)' -Value $command
New-Item -Path "$appKey\SupportedTypes" -Force | Out-Null
foreach ($ext in $exts) {
  New-ItemProperty -Path "$appKey\SupportedTypes" -Name $ext -PropertyType String -Value '' -Force | Out-Null
}

# App Paths (helps Windows resolve the app name)
$appPaths = "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\$appKeyName"
New-Item -Path $appPaths -Force | Out-Null
Set-ItemProperty -Path $appPaths -Name '(default)' -Value $exe
Set-ItemProperty -Path $appPaths -Name 'Path' -Value (Split-Path $exe)

# Notify shell
$signature = @'
using System;
using System.Runtime.InteropServices;
public class ShellNotify {
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
'@
Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue
[ShellNotify]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Output ''
Write-Output "Registered Open-with entry: $appName"
Write-Output "EXE: $exe"
Write-Output "Icon: $icon"
Write-Output "Command: $command"
