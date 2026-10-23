@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer, then try again.
  pause
  exit /b 1
)
node server.mjs
if errorlevel 1 pause
