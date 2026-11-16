@echo off
title Feud - local game server
cd /d "%~dp0"

python --version >nul 2>nul
if %errorlevel%==0 (
  start "" /min cmd /c "timeout /t 2 >nul & start http://localhost:8080/"
  echo Feud is running at http://localhost:8080   ^(close this window to stop^)
  python -m http.server 8080 --bind 127.0.0.1
  goto :eof
)

node --version >nul 2>nul
if %errorlevel%==0 (
  start "" /min cmd /c "timeout /t 2 >nul & start http://localhost:8080/"
  node server.js
  goto :eof
)

echo Python and Node.js were not found, so the game will open directly from disk instead.
echo (That works fine in Chrome or Edge.)
start "" "%~dp0index.html"
pause
