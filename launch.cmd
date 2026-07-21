@echo off
setlocal
cd /d "%~dp0"

if not exist "dist-electron\main.js" (
  echo Building...
  call npm run build
  if errorlevel 1 exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron binary missing. Run: npm install
  exit /b 1
)

if not exist "launcher\LightKaTeXEditor.exe" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-launcher.ps1"
)

REM Prefer named launcher so process/icon identity is Light KaTeX Editor.
start "" "launcher\LightKaTeXEditor.exe" %*
endlocal
