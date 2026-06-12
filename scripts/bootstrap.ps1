#Requires -Version 5.1
<#
.SYNOPSIS
  Statewave quickstart bootstrap (Windows).

.DESCRIPTION
  Gets a working Node 20+ runtime, then hands off to:
      npx @statewavedev/connectors-cli quickstart

  Trust model: if a suitable Node is already on PATH it is used as-is and
  nothing is downloaded. Otherwise Node is fetched from the OFFICIAL nodejs.org
  distribution, its SHA-256 is verified against the published SHASUMS256.txt,
  and it is unpacked into a user-local prefix (no admin, nothing outside your
  profile). The install only happens after you consent (a prompt, or -Yes for
  CI). We never claim Node is ready without first running `node --version`.

.EXAMPLE
  irm https://raw.githubusercontent.com/smaramwbc/statewave-connectors/main/scripts/bootstrap.ps1 | iex

.EXAMPLE
  .\scripts\bootstrap.ps1 -Yes -- --client all
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$QuickstartArgs
)

$ErrorActionPreference = 'Stop'

$MinNodeMajor = 20
$NodeDist = if ($env:STATEWAVE_NODE_DIST) { $env:STATEWAVE_NODE_DIST } else { 'https://nodejs.org/dist/latest-v22.x' }
$Prefix   = if ($env:STATEWAVE_HOME) { Join-Path $env:STATEWAVE_HOME 'node' } else { Join-Path $HOME '.statewave\node' }
$CliPkg   = if ($env:STATEWAVE_CLI_PKG) { $env:STATEWAVE_CLI_PKG } else { '@statewavedev/connectors-cli@latest' }

function Step([string]$m) { Write-Host $m -ForegroundColor White }
function Warn([string]$m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die ([string]$m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

function NodeMajor([string]$exe) {
  try { $v = (& $exe --version) 2>$null } catch { return $null }
  if ($v -match '^v?(\d+)\.') { return [int]$Matches[1] }
  return $null
}

# --- 1. reuse an existing good Node ---------------------------------------
$NodeBin = $null
$onPath = Get-Command node -ErrorAction SilentlyContinue
if ($onPath -and (NodeMajor $onPath.Source) -ge $MinNodeMajor) {
  $NodeBin = $onPath.Source
  Step "Node $(& node --version) found on PATH - using it."
}
elseif ((Test-Path "$Prefix\node.exe") -and ((NodeMajor "$Prefix\node.exe") -ge $MinNodeMajor)) {
  $NodeBin = "$Prefix\node.exe"
  $env:PATH = "$Prefix;$env:PATH"
  Step "Node $(& $NodeBin --version) found in $Prefix - using it."
}

# --- 2. otherwise fetch Node from the official dist (consented) ------------
if (-not $NodeBin) {
  switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { $NodeArch = 'x64' }
    'ARM64' { $NodeArch = 'arm64' }
    'x86'   { $NodeArch = 'x86' }
    default { Die "unsupported CPU '$($env:PROCESSOR_ARCHITECTURE)' - install Node ${MinNodeMajor}+ from https://nodejs.org and re-run." }
  }

  if ($onPath) { Warn "Node $(& node --version) is older than the required v$MinNodeMajor." }
  Write-Host ""
  Write-Host "Node ${MinNodeMajor}+ is required and was not found."
  Write-Host "  Source  $NodeDist  (official nodejs.org distribution)"
  Write-Host "  Install $Prefix   (your profile - no admin, nothing system-wide)"
  Write-Host "  Verify  SHA-256 checked against the published SHASUMS256.txt"
  if (-not $Yes) {
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
      $reply = Read-Host "Download and install Node there now? [Y/n]"
      if ($reply -match '^[Nn]') { Die "Aborted. Install Node ${MinNodeMajor}+ yourself, then re-run." }
    }
    else {
      Die "Non-interactive shell: re-run with -Yes to auto-install Node to $Prefix, or install Node ${MinNodeMajor}+ yourself."
    }
  }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("statewave-node-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Step "Resolving latest Node from $NodeDist ..."
    $shaFile = Join-Path $tmp 'SHASUMS256.txt'
    Invoke-WebRequest -UseBasicParsing -Uri "$NodeDist/SHASUMS256.txt" -OutFile $shaFile
    $row = Select-String -Path $shaFile -Pattern "  node-v.*-win-$NodeArch\.zip$" | Select-Object -First 1
    if (-not $row) { Die "no Node build for win-$NodeArch at $NodeDist - install Node ${MinNodeMajor}+ from https://nodejs.org." }
    $parts   = $row.Line -split '\s+'
    $wantSha = $parts[0]
    $file    = $parts[-1]

    Step "Downloading $file ..."
    $zip = Join-Path $tmp $file
    Invoke-WebRequest -UseBasicParsing -Uri "$NodeDist/$file" -OutFile $zip

    Step "Verifying SHA-256 ..."
    $gotSha = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if ($gotSha -ne $wantSha.ToLower()) { Die "checksum mismatch for $file - refusing to install. expected $wantSha, got $gotSha." }

    Step "Unpacking to $Prefix ..."
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $extracted = Join-Path $tmp ($file -replace '\.zip$', '')
    if (-not (Test-Path "$extracted\node.exe")) { Die "unexpected Node archive layout - $extracted\node.exe missing." }
    if (Test-Path $Prefix) { Remove-Item -Recurse -Force $Prefix }
    New-Item -ItemType Directory -Path (Split-Path $Prefix) -Force | Out-Null
    Move-Item $extracted $Prefix

    $NodeBin = "$Prefix\node.exe"
    $env:PATH = "$Prefix;$env:PATH"

    $gotMajor = NodeMajor $NodeBin
    if (-not $gotMajor -or $gotMajor -lt $MinNodeMajor) { Die "Node was unpacked but '$NodeBin --version' did not report v${MinNodeMajor}+." }
    Write-Host "+ Node $(& $NodeBin --version) installed in $Prefix and verified." -ForegroundColor Green
    Write-Host "  (add $Prefix to PATH to reuse it)" -ForegroundColor DarkGray
  }
  finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

# --- 3. hand off to quickstart --------------------------------------------
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { Die "npx not found next to node - your Node install looks incomplete." }
Write-Host ""
Step "Starting Statewave quickstart ..."
$forward = @($QuickstartArgs | Where-Object { $_ -ne '--' })
& npx -y $CliPkg quickstart @forward
exit $LASTEXITCODE
