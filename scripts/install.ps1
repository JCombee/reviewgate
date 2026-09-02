<#
.SYNOPSIS
  ReviewGate installer for Windows.

.DESCRIPTION
  Clones (or updates) the repo, builds it with npm, registers the marketplace and
  installs the plugin. Safe to run again: it updates in place.

    irm https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.ps1 | iex

.PARAMETER InstallDir
  Where to keep the checkout. Defaults to $env:USERPROFILE\.reviewgate.

.PARAMETER Ref
  Branch or tag to install. Defaults to main.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = $(if ($env:REVIEWGATE_HOME) { $env:REVIEWGATE_HOME } else { Join-Path $env:USERPROFILE ".reviewgate" }),
  [string]$Ref = $(if ($env:REVIEWGATE_REF) { $env:REVIEWGATE_REF } else { "main" }),
  [string]$RepoUrl = $(if ($env:REVIEWGATE_REPO) { $env:REVIEWGATE_REPO } else { "https://github.com/JCombee/reviewgate.git" })
)

$ErrorActionPreference = "Stop"

function Say([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Die([string]$msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }
function Have([string]$name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

# --- requirements ------------------------------------------------------------

if (-not (Have "git"))  { Die "git not found. Install git and run again: https://git-scm.com" }
if (-not (Have "node")) { Die "node not found. Install Node.js 20 or newer: https://nodejs.org" }
if (-not (Have "npm"))  { Die "npm not found. It ships with Node.js: https://nodejs.org" }

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Die "Node.js 20 or newer required, found $(node -v)." }

# --- the checkout ------------------------------------------------------------
#
# Running the file from a clone uses that clone; piped through iex there is no script
# path, so fall back to $InstallDir.

$srcDir = $null
if ($PSCommandPath) {
  $candidate = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
  $manifest = Join-Path $candidate "package.json"
  if ((Test-Path $manifest) -and ((Get-Content $manifest -Raw) -match '"reviewgate-monorepo"')) {
    $srcDir = $candidate
  }
}

if (-not $srcDir) {
  if (Test-Path (Join-Path $InstallDir ".git")) {
    Say "Updating $InstallDir"
    git -C $InstallDir fetch --depth 1 origin $Ref
    if (-not $?) { Die "git fetch failed." }
    git -C $InstallDir checkout -q FETCH_HEAD
  } else {
    Say "Cloning into $InstallDir"
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    git clone --depth 1 --branch $Ref $RepoUrl $InstallDir
    if (-not $?) { Die "git clone failed." }
  }
  $srcDir = $InstallDir
} else {
  Say "Using the checkout at $srcDir"
}

# --- build -------------------------------------------------------------------

Push-Location $srcDir
try {
  Say "Installing dependencies"
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die "npm install failed." }

  Say "Building"
  npm run build
  if ($LASTEXITCODE -ne 0) { Die "npm run build failed." }
} finally {
  Pop-Location
}

$cli = Join-Path $srcDir "packages\cli\bin\reviewgate.mjs"
if (-not (Test-Path $cli)) { Die "Build finished but $cli is missing." }

Say "Pointing Claude Code at the CLI"
node (Join-Path $srcDir "scripts\lib\set-env.mjs") $cli
if ($LASTEXITCODE -ne 0) { Die "Could not write REVIEWGATE_CLI into the Claude Code settings." }

# --- the plugin --------------------------------------------------------------

if (Have "claude") {
  Say "Registering the marketplace"
  claude plugin marketplace add $srcDir
  if ($LASTEXITCODE -ne 0) { claude plugin marketplace update reviewgate }

  Say "Installing the plugin"
  claude plugin install reviewgate@reviewgate
  if ($LASTEXITCODE -ne 0) { Die "claude plugin install failed." }
} else {
  Write-Host ""
  Write-Host "The 'claude' CLI is not on your PATH, so the plugin was not installed. Run these"
  Write-Host "two inside Claude Code instead:"
  Write-Host ""
  Write-Host "  /plugin marketplace add $srcDir"
  Write-Host "  /plugin install reviewgate@reviewgate"
}

Write-Host ""
Write-Host "ReviewGate is installed." -ForegroundColor Green
Write-Host "  checkout : $srcDir"
Write-Host "  cli      : $cli"
Write-Host ""
Write-Host "Restart Claude Code so it picks up the hook. Optionally put the CLI on your PATH:"
Write-Host "  npm link --workspace @reviewgate/cli   # from $srcDir"
