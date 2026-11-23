<#
Installs the herdr recipe into this device's herdr-app config and Claude Code commands.
Backs up anything it would overwrite to a timestamped folder first.
Run from the repo root:  .\install.ps1
#>

$ErrorActionPreference = "Stop"
$repo    = $PSScriptRoot
$herdr   = Join-Path $env:USERPROFILE ".config\herdr-app"
$cmds    = Join-Path $env:USERPROFILE ".claude\commands"
$stamp   = Get-Date -Format "yyyyMMdd-HHmmss"
$backup  = Join-Path $herdr "_backup-$stamp"

if (-not (Test-Path $herdr)) { throw "herdr-app config not found at $herdr - start herdr once first." }

# Files this recipe will drop in (relative to the herdr-app config root).
$targets = @(
  "keys.json",
  "layouts\tim-test.json",
  "mods\tim-spaces",
  "mods\tim-tabs"
)

# Back up any existing target before overwriting.
foreach ($t in $targets) {
  $dest = Join-Path $herdr $t
  if (Test-Path $dest) {
    $to = Join-Path $backup $t
    New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
    Copy-Item $dest $to -Recurse -Force
    Write-Host "backed up $t"
  }
}
if (Test-Path $backup) { Write-Host "existing files saved to $backup`n" }

# Copy the recipe in.
Copy-Item (Join-Path $repo "config\*") $herdr -Recurse -Force
New-Item -ItemType Directory -Force $cmds | Out-Null
Copy-Item (Join-Path $repo "claude\commands\edit-herdr.md") $cmds -Force

Write-Host "installed recipe into $herdr"
Write-Host "installed edit-herdr command into $cmds"
Write-Host "`nSwitch to the layout with:  herdr-app do layout.switch --name tim-test"
Write-Host "(or press Ctrl+Shift+L in herdr and pick tim-test)"
