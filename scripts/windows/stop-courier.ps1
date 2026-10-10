$ErrorActionPreference = "Continue"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$rootFwd = $root -replace "\\", "/"

function Resolve-ExistingFile([string]$path) {
  if (-not $path) {
    return $null
  }
  if (Test-Path -LiteralPath $path) {
    return (Resolve-Path -LiteralPath $path).Path
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

function Test-CourierCommand([string]$cmd) {
  if (-not $cmd) {
    return $false
  }
  $inRepo = ($cmd -like "*$root*") -or ($cmd -like "*$rootFwd*")
  if (-not $inRepo) {
    return $false
  }
  return ($cmd -like "*src\index.ts*") -or ($cmd -like "*src/index.ts*") -or ($cmd -like "*start-courier.ps1*")
}

$ids = New-Object "System.Collections.Generic.HashSet[int]"
$names = @{}
$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'")

foreach ($proc in $procs) {
  if (Test-CourierCommand ([string]$proc.CommandLine)) {
    [void]$ids.Add([int]$proc.ProcessId)
    $names[[int]$proc.ProcessId] = [string]$proc.Name
  }
}

$changed = $true
while ($changed) {
  $changed = $false
  foreach ($proc in $procs) {
    $procId = [int]$proc.ProcessId
    $parent = [int]$proc.ParentProcessId
    if ($ids.Contains($procId)) {
      continue
    }
    if ($parent -gt 0 -and $ids.Contains($parent)) {
      [void]$ids.Add($procId)
      $names[$procId] = [string]$proc.Name
      $changed = $true
    }
  }
}

$port = Read-Port (Resolve-EnvFile $root) 8787
$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $ownerId = [int]$listener.OwningProcess
  if ($ownerId -le 0 -or $ids.Contains($ownerId)) {
    continue
  }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue
  if ($owner -and ([string]$owner.Name -eq "node.exe" -or [string]$owner.Name -eq "powershell.exe" -or [string]$owner.Name -eq "pwsh.exe")) {
    [void]$ids.Add($ownerId)
    $names[$ownerId] = [string]$owner.Name
  }
}

if ($ids.Count -eq 0) {
  Write-Host "No running Courier process."
  exit 0
}

foreach ($procId in @($ids)) {
  & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $label = $names[$procId]
    if (-not $label) {
      $label = "process"
    }
    Write-Host ("Stopped {0} ({1})" -f $label, $procId)
  }
}

Start-Sleep -Milliseconds 400
$still = @()
foreach ($procId in @($ids)) {
  $alive = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($alive) {
    $still += $procId
  }
}
if ($still.Count -gt 0) {
  Write-Host ("Still running: {0}" -f ($still -join ", "))
  exit 1
}

$left = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" | Where-Object {
  Test-CourierCommand ([string]$_.CommandLine)
})
if ($left.Count -gt 0) {
  Write-Host ("Still running: {0}" -f (($left | ForEach-Object { $_.ProcessId }) -join ", "))
  exit 1
}

exit 0
