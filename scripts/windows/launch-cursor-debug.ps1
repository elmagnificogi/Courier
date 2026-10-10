$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Windows.Forms | Out-Null

function Find-CursorExe {
  $candidates = @(
    "D:\cursor\Cursor.exe",
    (Join-Path $env:LOCALAPPDATA "Programs\cursor\Cursor.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Cursor\Cursor.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Show-Note([string]$message) {
  [System.Windows.Forms.MessageBox]::Show(
    $message,
    "Cursor debug",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  ) | Out-Null
}

$exe = Find-CursorExe
if (-not $exe) {
  Show-Note "Cursor.exe was not found. Edit scripts/windows/launch-cursor-debug.ps1 and set the real path."
  exit 1
}

$portUp = @(Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue)
$mains = @(Get-CimInstance Win32_Process -Filter "Name = 'Cursor.exe'" | Where-Object {
  $cmd = [string]$_.CommandLine
  $cmd -and ($cmd -notlike "*--type=*")
})
$withDebug = @($mains | Where-Object { [string]$_.CommandLine -like "*--remote-debugging-port=9222*" })

if ($portUp.Count -gt 0 -or $withDebug.Count -gt 0) {
  Start-Process -FilePath $exe
  exit 0
}

if ($mains.Count -gt 0) {
  Show-Note "Cursor is already running without remote debugging, so port 9222 is closed.`r`nQuit Cursor completely (File > Exit), confirm Cursor.exe is gone, then open this shortcut again.`r`nOpening it while Cursor is already running does not add the debug port."
  exit 1
}

Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=9222","--remote-allow-origins=*"
exit 0
