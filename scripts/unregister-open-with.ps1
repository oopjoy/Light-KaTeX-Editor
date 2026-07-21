$ErrorActionPreference = 'Stop'
$progId = 'LightKaTeXEditor.md'
$exts = @('.md', '.markdown', '.mdown', '.mkd', '.mkdn')

Remove-Item -Path "HKCU:\Software\Classes\$progId" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Classes\Applications\LightKaTeXEditor.vbs' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Classes\Applications\LightKaTeXEditor.exe' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\LightKaTeXEditor.exe' -Recurse -Force -ErrorAction SilentlyContinue

foreach ($ext in $exts) {
  Remove-ItemProperty -Path "HKCU:\Software\Classes\$ext\OpenWithProgids" -Name $progId -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\OpenWithProgids" -Name $progId -Force -ErrorAction SilentlyContinue
}

Write-Output 'Unregistered Light KaTeX Editor from Open with.'
