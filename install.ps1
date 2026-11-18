# Idempotent installer for dsh-token-usage-panel.
#
# Recreates the profile-side junction and makes sure the profile patch carries
# the loader row. Safe to run repeatedly.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
param(
  [string]$ProfileDir = $(if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }),
  [string]$PackageDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ProfileDir)) { throw "profile directory not found: $ProfileDir" }
if (-not (Test-Path (Join-Path $PackageDir 'package.json'))) { throw "package.json not found in $PackageDir" }

# 1. junction: <profile>/node_modules/dsh-token-usage-panel -> this package
$link = Join-Path $ProfileDir 'node_modules\dsh-token-usage-panel'
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.LinkType -eq 'Junction') {
    Write-Host "junction already present: $link -> $($item.LinkTarget)"
  } else {
    Write-Host "replacing non-junction entry: $link"
    Remove-Item $link -Recurse -Force
    New-Item -ItemType Junction -Path $link -Target $PackageDir | Out-Null
  }
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $link) | Out-Null
  New-Item -ItemType Junction -Path $link -Target $PackageDir | Out-Null
  Write-Host "junction created: $link -> $PackageDir"
}

# 2. loader row in the profile patch (config layer reloads live under HMR)
$patch = Join-Path $ProfileDir 'cordis.patch.yml'
$text = [System.IO.File]::ReadAllText($patch)
$marker = 'id: token-usage-panel'
if ($text.Contains($marker)) {
  Write-Host "patch already declares token-usage-panel: $patch"
} else {
  $block = @"

# Real-time token usage readout (dsh-token-usage-panel). Client-only: reads the
# tokenUsage / contextPressure / contextBreakdown / sessionStats Session
# projections and renders a header chip plus a detail panel.
- insert:
    - id: token-usage-panel
      name: dsh-token-usage-panel
"@
  [System.IO.File]::AppendAllText($patch, $block, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "patch updated: $patch"
}

# 3. resolution smoke test
$resolved = & node -e "console.log(require.resolve('dsh-token-usage-panel/package.json',{paths:[process.argv[1]]}))" $ProfileDir
Write-Host 'resolved: ' $resolved
Write-Host 'restart DSH Desktop once: the host half registers the balance routes at startup, and host modules are not hot-reloaded.'
