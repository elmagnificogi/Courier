$ErrorActionPreference = "Continue"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $root

$tmp = Join-Path $root "tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$log = Join-Path $tmp "courier-autostart.log"

function Write-Log([string]$message) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
  Add-Content -LiteralPath $log -Value $line -Encoding utf8
}

$port = 8787
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
  $match = Select-String -LiteralPath $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($match) {
    $port = [int]$match.Matches[0].Groups[1].Value
  }
}

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Log "Courier already listening on port $port, skip start"
  exit 0
}

$nodeCandidates = @(
  "E:\nodejs\node.exe",
  (Join-Path $env:ProgramFiles "nodejs\node.exe")
)
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeCandidates = @($nodeCmd.Source) + $nodeCandidates
}
$node = $nodeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $node) {
  Write-Log "node.exe not found"
  exit 1
}

$tsx = Join-Path $root "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path $tsx)) {
  Write-Log "tsx not found; run npm install in $root"
  exit 1
}

$nodeDir = Split-Path $node -Parent
$env:Path = "$nodeDir;$env:Path"
Write-Log "Starting Courier: $node $tsx src/index.ts"
& $node $tsx (Join-Path $root "src\index.ts") *>> $log
Write-Log "Courier process exited with code $LASTEXITCODE"
exit $LASTEXITCODE
