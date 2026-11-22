param(
  [string]$ArtifactPath = ".\skymp\artifacts\server-dist",
  [string]$ServerPath = ".\skymp\server",
  [string]$GamemodePath = "..\gamemode\phase0-basic.js",
  [switch]$OfflineMode
)

$ErrorActionPreference = "Stop"

# Anchored on $PSScriptRoot, not the working directory: running this script from
# inside scripts/phase0 (or via "Run with PowerShell" in Explorer, which opens
# in another cwd) made the relative paths below point to the wrong place
# and the script fail with "Missing local settings" even though the file existed.
# Found on 2026-08-21 while helping an external fork bring the server up.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

if (-not [System.IO.Path]::IsPathRooted($ArtifactPath)) {
  $ArtifactPath = Join-Path $root $ArtifactPath
}

if (-not (Test-Path -LiteralPath $ArtifactPath)) {
  Write-Error "Artifact path not found: $ArtifactPath"
}

$server = Join-Path $root $ServerPath
$artifact = Resolve-Path -LiteralPath $ArtifactPath

if (Test-Path -LiteralPath $server) {
  Remove-Item -LiteralPath $server -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $server | Out-Null

Get-ChildItem -LiteralPath $artifact -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $server -Recurse -Force
}

$localSettings = Join-Path $root "skymp\config\server-settings.local.json"
$serverSettings = Join-Path $server "server-settings.json"

if (-not (Test-Path -LiteralPath $localSettings)) {
  Write-Error "Missing local settings. Run scripts/phase0/Initialize-LocalConfig.ps1 first."
}

$settings = Get-Content -Raw -LiteralPath $localSettings | ConvertFrom-Json
$settings.dataDir = "..\data"
$settings.loadOrder = @(
  "Skyrim.esm",
  "Update.esm",
  "Dawnguard.esm",
  "HearthFires.esm",
  "Dragonborn.esm"
)
$settings.databaseDriver = "file"
$settings.databaseName = "..\world"
$settings.gamemodePath = $GamemodePath
$settings.offlineMode = [bool]$OfflineMode
$settings.isPapyrusHotReloadEnabled = $false
# NPCs: SkyMP disables every NPC unless npcEnabled is true. The template sets
# it; an older server-settings.local.json may not have it. Warn, do not guess.
# Do NOT add npcSettings here: see docs/technical/NPC_SPAWN_FILTER.md.
if ($null -eq $settings.PSObject.Properties['npcEnabled']) {
  Write-Warning "server-settings.local.json has no npcEnabled: SkyMP will spawn NO NPCs (no wolves, no bandits). Add `"npcEnabled`": true (see server-settings.local.example.json)."
}
$settings | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $serverSettings -Encoding ASCII

$scriptsDir = Join-Path $root "skymp\data\scripts"
New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null

$artifactScripts = Join-Path $artifact "data\scripts"
if (Test-Path -LiteralPath $artifactScripts) {
  Get-ChildItem -LiteralPath $artifactScripts -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $scriptsDir -Recurse -Force
  }
}

& (Join-Path $PSScriptRoot "Write-ServerBuildInfo.ps1") -ServerPath $server

Write-Host "Installed server artifact into $server"
Write-Host "Review $serverSettings before starting."
Write-Host "offlineMode=$($settings.offlineMode)"
