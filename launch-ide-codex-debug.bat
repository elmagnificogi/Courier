@echo off
echo Launching Codex with remote debugging on port 9225...
if exist "%LOCALAPPDATA%\Programs\Codex\Codex.exe" (
  "%LOCALAPPDATA%\Programs\Codex\Codex.exe" --remote-debugging-port=9225 --remote-allow-origins=*
  goto :eof
)
if exist "%LOCALAPPDATA%\Programs\ChatGPT\ChatGPT.exe" (
  "%LOCALAPPDATA%\Programs\ChatGPT\ChatGPT.exe" --remote-debugging-port=9225 --remote-allow-origins=*
  goto :eof
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\launch-codex-debug.ps1"
if errorlevel 1 (
  echo Codex.exe / ChatGPT.exe was not found, and the Store app could not be activated.
  echo Start the Codex desktop app manually with --remote-debugging-port=9225
)
