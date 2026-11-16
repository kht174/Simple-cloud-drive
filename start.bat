@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js 18 or newer: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Starting netdisk at http://127.0.0.1:3000
echo On first run, read the setup token in another terminal:
echo   type .initial-setup-token
echo Press Ctrl+C to stop.
node server.js
pause
