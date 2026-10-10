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
echo Codex.exe / ChatGPT.exe was not found under %%LOCALAPPDATA%%\Programs.
echo Start the Codex desktop app manually with --remote-debugging-port=9225
