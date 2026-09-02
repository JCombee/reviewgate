<#
.SYNOPSIS
  ReviewGate installer for Windows.

.DESCRIPTION
  Downloads one self-contained binary from the newest GitHub release, checks its
  SHA-256 and drops it in %LOCALAPPDATA%\Programs\reviewgate. No Node, no npm, no
  checkout. Run it again to update; `reviewgate update` does the same from inside
  the binary.

    irm https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.ps1 | iex

.PARAMETER Version
  Install exactly this tag instead of the newest release.

.PARAMETER InstallDir
  Install somewhere other than %LOCALAPPDATA%\Programs\reviewgate.

.PARAMETER NoPlugin
  Only place the binary; leave Claude Code alone.
#>
[CmdletBinding()]
param(
  [string]$Version = $(if ($env:REVIEWGATE_VERSION) { $env:REVIEWGATE_VERSION } else { "latest" }),
  [string]$InstallDir = $(if ($env:REVIEWGATE_INSTALL_DIR) { $env:REVIEWGATE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\reviewgate" }),
  [string]$Repo = $(if ($env:REVIEWGATE_REPO) { $env:REVIEWGATE_REPO } else { "JCombee/reviewgate" }),
  [switch]$NoPlugin
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say([string]$m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host "warning: $m" -ForegroundColor Yellow }
function Die([string]$m)  { Write-Host "error: $m" -ForegroundColor Red; exit 1 }
function Have([string]$n) { $null -ne (Get-Command $n -ErrorAction SilentlyContinue) }

# --- which binary ------------------------------------------------------------

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
if ($arch -eq "arm64") {
  # The x64 build runs under emulation on ARM64 Windows; there is no separate ARM64
  # asset yet, and a working binary beats a missing one.
  $arch = "x64"
}
$asset = "reviewgate-win32-$arch.exe"

# --- which release -----------------------------------------------------------

$headers = @{ "User-Agent" = "reviewgate-install" }
$token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { $null }
if (-not $token -and (Have "gh")) {
  $token = (gh auth token --hostname github.com 2>$null)
  if (-not $token) { $token = $null }
}
if ($token) { $headers["Authorization"] = "Bearer $($token.Trim())" }

if ($Version -eq "latest") {
  Say "Looking up the newest release"
  $api = "https://api.github.com/repos/$Repo/releases/latest"
  try {
    $release = Invoke-RestMethod -Uri $api -Headers $headers
  } catch {
    # A stale token gets a 401 where an anonymous request would have worked.
    try {
      $release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "reviewgate-install" }
    } catch {
      Die "could not read the releases of $Repo. $($_.Exception.Message)"
    }
  }
  $tag = $release.tag_name
  if (-not $tag) { Die "$Repo has no releases yet." }
} else {
  $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
}

# --- download and verify -----------------------------------------------------

$url = "https://github.com/$Repo/releases/download/$tag/$asset"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("reviewgate-" + [guid]::NewGuid().ToString("N") + ".exe")

Say "Downloading $asset $tag"
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -Headers @{ "User-Agent" = "reviewgate-install" }
} catch {
  Die "$tag has no $asset. $($_.Exception.Message)"
}
try {
  $expected = (Invoke-WebRequest -Uri "$url.sha256" -UseBasicParsing -Headers @{ "User-Agent" = "reviewgate-install" }).Content
} catch {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  Die "no checksum published for $asset."
}

# GitHub serves the .sha256 as application/octet-stream, and Windows PowerShell hands
# back a Byte[] rather than a string for those. Splitting that on whitespace yields the
# first byte value, which never matches and would fail every install.
if ($expected -is [byte[]]) { $expected = [Text.Encoding]::ASCII.GetString($expected) }
$expectedHash = ([string]$expected).Trim() -split '\s+' | Select-Object -First 1
$actualHash = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash
if ($actualHash -ine $expectedHash) {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  Die "checksum mismatch - refusing to install."
}

if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Force $InstallDir | Out-Null }
$target = Join-Path $InstallDir "reviewgate.exe"

# A running gate holds the old binary open; move it aside rather than failing.
if (Test-Path $target) {
  $old = "$target.old"
  Remove-Item $old -Force -ErrorAction SilentlyContinue
  try { Move-Item $target $old -Force } catch { Die "reviewgate.exe is in use. Close it and run again." }
}
Move-Item $tmp $target -Force
Say "reviewgate $tag installed at $target"

# --- PATH --------------------------------------------------------------------
#
# The plugin runs `reviewgate hook`, so the gate only works when the shell Claude
# Code starts can find it. setx-style user PATH edits reach new processes only.

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$onPath = ($userPath -split ';' | Where-Object { $_.Trim().TrimEnd('\') -ieq $InstallDir.TrimEnd('\') }).Count -gt 0
if (-not $onPath) {
  Say "Adding $InstallDir to your user PATH"
  $updated = if ([string]::IsNullOrWhiteSpace($userPath)) { $InstallDir } else { "$($userPath.TrimEnd(';'));$InstallDir" }
  [Environment]::SetEnvironmentVariable("Path", $updated, "User")
  $env:Path = "$env:Path;$InstallDir"
  Warn "Open a new terminal (and restart Claude Code) so the new PATH is picked up."
}

# --- the Claude Code plugin --------------------------------------------------

if (-not $NoPlugin) {
  if (Have "claude") {
    Say "Installing the Claude Code plugin"
    claude plugin marketplace add $Repo
    if ($LASTEXITCODE -ne 0) { claude plugin marketplace update reviewgate }
    claude plugin install reviewgate@reviewgate
    if ($LASTEXITCODE -ne 0) { Warn "could not install the plugin; do it from Claude Code." }
  } else {
    Write-Host ""
    Write-Host "The 'claude' CLI is not on your PATH. Run these inside Claude Code instead:"
    Write-Host ""
    Write-Host "  /plugin marketplace add $Repo"
    Write-Host "  /plugin install reviewgate@reviewgate"
  }
}

Write-Host ""
Write-Host "Done. Restart Claude Code so the gate picks up the hook." -ForegroundColor Green
Write-Host "  reviewgate --version    what you have"
Write-Host "  reviewgate update       pull in the next release"
