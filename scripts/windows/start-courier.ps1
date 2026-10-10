$ErrorActionPreference = "Continue"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $root

$tmp = Join-Path $root "tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$log = Join-Path $tmp "courier-autostart.log"

$utf8 = New-Object System.Text.UTF8Encoding $false

function Add-SharedLogText([string]$text) {
  $bytes = $utf8.GetBytes($text)
  $stream = New-Object System.IO.FileStream(
    $log,
    [System.IO.FileMode]::Append,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::ReadWrite
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
  } finally {
    $stream.Dispose()
  }
}

function Write-Log([string]$message) {
  $line = "{0} {1}{2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message, [Environment]::NewLine
  Add-SharedLogText $line
}

function Reset-LogIfFree {
  try {
    $stream = New-Object System.IO.FileStream(
      $log,
      [System.IO.FileMode]::Create,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::ReadWrite
    )
    $stream.Dispose()
  } catch {
    Write-Host ("Log file is in use, appending instead: {0}" -f $log)
  }
}

function Get-RegistryPathEntries {
  $entries = @()
  foreach ($scope in @(
    "HKCU:\Environment",
    "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
  )) {
    $raw = (Get-ItemProperty -Path $scope -Name Path -ErrorAction SilentlyContinue).Path
    if ($raw) {
      $entries += ($raw -split ";" | Where-Object { $_ -and $_.Trim() })
    }
  }
  return $entries
}

function Resolve-ExistingFile([string]$path) {
  if (-not $path) {
    return $null
  }
  if (Test-Path -LiteralPath $path) {
    return (Resolve-Path -LiteralPath $path).Path
  }
  return $null
}

function Resolve-NodeExe {
  $override = Resolve-ExistingFile $env:COURIER_NODE
  if ($override) {
    return $override
  }

  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    $fromCommand = Resolve-ExistingFile $command.Source
    if ($fromCommand) {
      return $fromCommand
    }
  }

  $dirs = @()
  if ($env:Path) {
    $dirs += ($env:Path -split ";" | Where-Object { $_ -and $_.Trim() })
  }
  $dirs += Get-RegistryPathEntries
  foreach ($dir in $dirs) {
    $candidate = Resolve-ExistingFile (Join-Path $dir.Trim() "node.exe")
    if ($candidate) {
      return $candidate
    }
  }

  $appPaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\node.exe",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\node.exe"
  )
  foreach ($key in $appPaths) {
    $registered = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue)."(default)"
    $fromRegistry = Resolve-ExistingFile $registered
    if ($fromRegistry) {
      return $fromRegistry
    }
  }

  $nvmLink = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "User")
  if (-not $nvmLink) {
    $nvmLink = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "Machine")
  }
  $fixed = @(
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"),
    (Join-Path $env:USERPROFILE "scoop\apps\nodejs\current\node.exe"),
    (Join-Path $env:USERPROFILE "scoop\apps\nodejs-lts\current\node.exe"),
    (Join-Path $env:USERPROFILE ".volta\bin\node.exe")
  )
  if ($nvmLink) {
    $fixed += (Join-Path $nvmLink "node.exe")
  }
  foreach ($candidate in $fixed) {
    $found = Resolve-ExistingFile $candidate
    if ($found) {
      return $found
    }
  }
  return $null
}

function Resolve-EnvFile([string]$projectRoot) {
  if ($env:DOTENV_CONFIG_PATH) {
    $configured = $env:DOTENV_CONFIG_PATH
    if (-not [System.IO.Path]::IsPathRooted($configured)) {
      $configured = Join-Path $projectRoot $configured
    }
    $explicit = Resolve-ExistingFile $configured
    if ($explicit) {
      return $explicit
    }
    $script:envNote = "DOTENV_CONFIG_PATH does not exist: $($env:DOTENV_CONFIG_PATH)"
  }

  $dotenv = Resolve-ExistingFile (Join-Path $projectRoot ".env")
  if ($dotenv) {
    return $dotenv
  }

  $named = @(
    foreach ($name in @(".env.cursor", ".env.codex", ".env.windsurf", ".env.vscode")) {
      $path = Join-Path $projectRoot $name
      if (Test-Path -LiteralPath $path) {
        $path
      }
    }
  )
  if ($named.Count -eq 1) {
    return (Resolve-Path -LiteralPath $named[0]).Path
  }
  if ($named.Count -gt 1) {
    $script:envNote = "Multiple env files found. Set DOTENV_CONFIG_PATH. Candidates: {0}" -f ($named -join ", ")
  }
  return $null
}

function Read-Port([string]$filePath, [int]$fallback) {
  if (-not $filePath) {
    return $fallback
  }
  $match = Select-String -LiteralPath $filePath -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($match) {
    return [int]$match.Matches[0].Groups[1].Value
  }
  return $fallback
}

$envFile = Resolve-EnvFile $root
if ($envFile) {
  $env:DOTENV_CONFIG_PATH = $envFile
}

$port = Read-Port $envFile 8787
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host ("Courier is already listening on port {0}. Run stop-courier.ps1 before starting again." -f $port)
  exit 0
}

Reset-LogIfFree
if ($script:envNote) {
  Write-Log $script:envNote
}
if ($envFile) {
  Write-Log "Env file: $envFile"
} elseif (-not $script:envNote) {
  Write-Log "No .env or .env.<ide> file found; Courier will start with built-in defaults"
}

$node = Resolve-NodeExe
if (-not $node) {
  Write-Log "node.exe not found. Install Node.js, add it to PATH, or set COURIER_NODE to the full path of node.exe"
  exit 1
}

$tsx = Join-Path $root "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path -LiteralPath $tsx)) {
  Write-Log "tsx not found; run npm install in $root"
  exit 1
}

$nodeDir = Split-Path $node -Parent
$env:Path = "$nodeDir;$env:Path"
$env:NO_COLOR = "1"
$env:COURIER_LOG_FILE = $log
$entry = Join-Path $root "src\index.ts"
Write-Log "Starting Courier: $node $tsx src/index.ts"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = ('"{0}" "{1}"' -f $tsx, $entry)
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.StandardErrorEncoding = $utf8

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
[void]$proc.Start()
$stderrCopy = [powershell]::Create().AddScript({
  param($reader, $path, $encoding)
  while ($null -ne ($line = $reader.ReadLine())) {
    $bytes = $encoding.GetBytes($line + [Environment]::NewLine)
    $stream = New-Object System.IO.FileStream(
      $path,
      [System.IO.FileMode]::Append,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::ReadWrite
    )
    try {
      $stream.Write($bytes, 0, $bytes.Length)
    } finally {
      $stream.Dispose()
    }
  }
}).AddArgument($proc.StandardError).AddArgument($log).AddArgument($utf8)
$stderrHandle = $stderrCopy.BeginInvoke()
$proc.WaitForExit()
[void]$stderrCopy.EndInvoke($stderrHandle)
$stderrCopy.Dispose()
Write-Log "Courier process exited with code $($proc.ExitCode)"
exit $proc.ExitCode
