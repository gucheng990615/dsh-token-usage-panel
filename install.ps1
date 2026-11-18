<#
.SYNOPSIS
  One-command installer for dsh-token-usage-panel.

.DESCRIPTION
  Downloads this plugin from GitHub (no git required), drops it into the target
  DeepSeek Harness profile's node_modules, and appends the loader row to
  cordis.patch.yml. Safe to run repeatedly; nothing else on the machine changes.

.EXAMPLE
  irm https://raw.githubusercontent.com/gucheng990615/dsh-token-usage-panel/main/install.ps1 | iex

.EXAMPLE
  # from a local checkout, or a different branch
  .\install.ps1 -Source . -Ref v1.0.0

.EXAMPLE
  # remove everything this script installed
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$ProfileDir,
  [string]$Ref = 'main',
  [string]$Source,
  [switch]$Uninstall,
  [string]$Owner = 'gucheng990615',
  [string]$Repo = 'dsh-token-usage-panel'
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-token-usage-panel'

function Write-Step($text) { Write-Host "  $text" }
function Fail($text) { throw $text }

# --- locate the profile ------------------------------------------------------
if (-not $ProfileDir) {
  if ($env:DSH_PROFILE_DIR) { $ProfileDir = $env:DSH_PROFILE_DIR }
  elseif ($env:DSH_HOME) { $ProfileDir = Join-Path $env:DSH_HOME 'profiles\desktop' }
  else { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
}
if (-not (Test-Path $ProfileDir)) { Fail "profile directory not found: $ProfileDir (pass -ProfileDir)" }
$ProfileDir = (Resolve-Path $ProfileDir).Path
$target = Join-Path $ProfileDir "node_modules\$PackageName"
$patch = Join-Path $ProfileDir 'cordis.patch.yml'

Write-Host ''
Write-Host "$PackageName -> $ProfileDir" -ForegroundColor Cyan

# --- uninstall ---------------------------------------------------------------
if ($Uninstall) {
  if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
    Write-Step "removed $target"
  } else {
    Write-Step 'package directory already absent'
  }
  if ((Test-Path $patch) -and ([System.IO.File]::ReadAllText($patch)).Contains("id: $PackageName")) {
    $lines = [System.IO.File]::ReadAllLines($patch)
    $out = New-Object System.Collections.Generic.List[string]
    $skipping = $false
    foreach ($line in $lines) {
      if ($line -match "^\s*- id: $PackageName\s*$") {
        $skipping = $true
        if ($out.Count -gt 0 -and $out[$out.Count - 1] -match '^\s*- insert:\s*$') { $out.RemoveAt($out.Count - 1) }
        continue
      }
      if ($skipping) {
        if ($line -match '^\s{6,}\S' -or $line -match '^\s*$') { continue }
        $skipping = $false
      }
      $out.Add($line)
    }
    while ($out.Count -gt 0 -and $out[$out.Count - 1] -match '^\s*$') { $out.RemoveAt($out.Count - 1) }
    $out = [System.Collections.Generic.List[string]]@($out | Where-Object { $_ -notmatch '^\s*#\s*dsh-token-usage-panel:' })
    $backup = "$patch.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item $patch $backup -Force
    [System.IO.File]::WriteAllLines($patch, $out, (New-Object System.Text.UTF8Encoding($false)))
    Write-Step "loader row removed (backup: $(Split-Path $backup -Leaf))"
  }
  Write-Host "`nDone. Restart DeepSeek Harness to finish uninstalling." -ForegroundColor Green
  return
}

# --- stage the package -------------------------------------------------------
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("$PackageName-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

try {
  if ($Source) {
    if (-not (Test-Path (Join-Path $Source 'package.json'))) { Fail "no package.json in $Source" }
    Copy-Item (Join-Path $Source '*') $stage -Recurse -Force
    Write-Step "staged from local path: $Source"
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $kind = if ($Ref -match '^v\d') { 'tags' } else { 'heads' }
    $url = "https://codeload.github.com/$Owner/$Repo/zip/refs/$kind/$Ref"
    $zip = Join-Path $stage 'package.zip'
    Write-Step "downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 120
    Expand-Archive -Path $zip -DestinationPath (Join-Path $stage 'unpacked') -Force
    $root = Get-ChildItem (Join-Path $stage 'unpacked') -Directory | Select-Object -First 1
    if (-not $root) { Fail 'unexpected archive layout' }
    Copy-Item (Join-Path $root.FullName '*') $stage -Recurse -Force
    Remove-Item $zip, (Join-Path $stage 'unpacked') -Recurse -Force
    Write-Step "staged $Repo@$Ref"
  }
  if (-not (Test-Path (Join-Path $stage 'package.json'))) { Fail 'package.json missing after staging' }

  # --- install into the profile ---------------------------------------------
  if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType) { Remove-Item $target -Force }
    else { Remove-Item $target -Recurse -Force }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  foreach ($item in 'package.json', 'client.js', 'lib', 'README.md', 'LICENSE') {
    $from = Join-Path $stage $item
    if (Test-Path $from) { Copy-Item $from (Join-Path $target $item) -Recurse -Force }
  }
  Write-Step "installed -> $target"
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

# --- loader row --------------------------------------------------------------
$block = @"

# dsh-token-usage-panel: live token usage + account balance chip in the session header.
- insert:
    - id: $PackageName
      name: $PackageName
"@
if (-not (Test-Path $patch)) {
  [System.IO.File]::WriteAllText($patch, $block.TrimStart("`r", "`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Step "created $patch"
} elseif (([System.IO.File]::ReadAllText($patch)).Contains("id: $PackageName")) {
  Write-Step 'loader row already present'
} else {
  $backup = "$patch.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $patch $backup -Force
  [System.IO.File]::AppendAllText($patch, $block, (New-Object System.Text.UTF8Encoding($false)))
  Write-Step "loader row appended (backup: $(Split-Path $backup -Leaf))"
}

Write-Host ''
Write-Host 'Installed. Restart DeepSeek Harness once - the host half registers its' -ForegroundColor Green
Write-Host 'routes at startup and host modules are not hot-reloaded. After the restart,' -ForegroundColor Green
Write-Host 'a balance chip appears next to the session title.' -ForegroundColor Green
