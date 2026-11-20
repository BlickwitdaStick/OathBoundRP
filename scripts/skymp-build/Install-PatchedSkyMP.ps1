# Installs the patched SkyMP (light/ESL plugin support) into this repo's server
# and/or a Skyrim client, backing up every file it replaces.
#
#   # from a local build (Build-PatchedSkyMP.ps1):
#   powershell -ExecutionPolicy Bypass -File scripts\skymp-build\Install-PatchedSkyMP.ps1 -SkyrimDir "D:\Games\Skyrim Special Edition"
#   # from a shared zip (OATHBOUND-patched-skymp.zip, unpacked):
#   ... Install-PatchedSkyMP.ps1 -DistDir C:\Downloads\OATHBOUND-patched-skymp -SkyrimDir "..."
#
# Never writes skymp5-client-settings.txt (that file holds the connection and
# must never get an offline profileId). Stop the game server and the game first.
param(
  # Folder holding server\ and client\ (a build's dist folder or the shared zip).
  [string]$DistDir = (Join-Path (Split-Path (Resolve-Path "$PSScriptRoot\..\..")) 'skymp-src\build\dist'),
  # Skyrim Special Edition folder (the one with SkyrimSE.exe). Omit to skip the client.
  [string]$SkyrimDir,
  [switch]$SkipServer
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not $SkipServer) {
  $srv = Join-Path $repo 'skymp\server'
  if (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'skymp5-server' }) { throw 'The game server is running. Stop it first.' }
  if (-not (Test-Path (Join-Path $srv 'dist_back'))) {
    # Fresh machine: lay down the whole server folder from the bundle.
    if (-not (Test-Path (Join-Path $DistDir 'server\package.json'))) { throw "No SkyMP server in $srv and $DistDir\server is not a full server folder (use the shared OATHBOUND-patched-skymp.zip)." }
    New-Item -ItemType Directory -Force $srv | Out-Null
    Copy-Item -Path (Join-Path $DistDir 'server\*') -Destination $srv -Recurse -Force
    Write-Host "server: installed full server folder into $srv"
    $SkipServerSwap = $true
  }
}
if (-not $SkipServer -and -not $SkipServerSwap) {
  $bk = Join-Path $repo "backups\skymp-server-$stamp"
  foreach ($f in 'scam_native.node', 'scam_native.pdb', 'dist_back\skymp5-server.js', 'dist_back\skymp5-server.js.map') {
    $src = Join-Path $DistDir "server\$f"; $dst = Join-Path $srv $f
    if (-not (Test-Path $src)) { if ($f -like '*.pdb') { continue } else { throw "Missing $src" } }
    if (Test-Path $dst) { $b = Join-Path $bk $f; New-Item -ItemType Directory -Force (Split-Path $b) | Out-Null; Copy-Item -LiteralPath $dst $b -Force }
    Copy-Item -LiteralPath $src $dst -Force
    Write-Host "server: $f"
  }
  Write-Host "Server backups: $bk"
  Write-Host 'Remember: skymp\config\client-mods.local.json needs "serverSupportsLightPlugins": true' -ForegroundColor Yellow
}

if ($SkyrimDir) {
  if (-not (Test-Path (Join-Path $SkyrimDir 'SkyrimSE.exe'))) { throw "$SkyrimDir does not contain SkyrimSE.exe" }
  if (Get-Process SkyrimSE -ErrorAction SilentlyContinue) { throw 'Skyrim is running. Close it first.' }
  $c = Join-Path $DistDir 'client'
  $bk = Join-Path $repo "skymp\client-backups\$stamp"
  $n = 0
  foreach ($f in Get-ChildItem $c -Recurse -File) {
    $rel = $f.FullName.Substring($c.Length + 1)
    if ($rel -match 'skymp5-client-settings\.txt$' -or $rel -match '\\plugin-example\\') { continue }
    $g = Join-Path $SkyrimDir $rel
    if ((Test-Path $g) -and ((Get-FileHash $g).Hash -eq (Get-FileHash $f.FullName).Hash)) { continue }
    if (Test-Path $g) { $b = Join-Path $bk $rel; New-Item -ItemType Directory -Force (Split-Path $b) | Out-Null; Copy-Item -LiteralPath $g $b -Force }
    New-Item -ItemType Directory -Force (Split-Path $g) | Out-Null
    Copy-Item -LiteralPath $f.FullName $g -Force; $n++
    Write-Host "client: $rel"
  }
  Write-Host "$n client file(s) updated. Backups: $bk"
}
