# Builds the OATHBOUND SkyMP (upstream pin + patches/skymp/light-plugins.patch).
#
#   powershell -ExecutionPolicy Bypass -File scripts\skymp-build\Build-PatchedSkyMP.ps1
#
# Needs: git, Node 18+, yarn 1.x, CMake 3.28+ and Visual Studio (2022 or 2026)
# with "Desktop development with C++". The first build downloads and compiles
# vcpkg dependencies and takes a long time (an hour or more); later builds are
# incremental. Nothing is installed into Skyrim: see Install-PatchedSkyMP.ps1.
param(
  # Where the SkyMP source tree lives (cloned here if missing). Keep it short:
  # Windows path-length limits break vcpkg builds in deep folders.
  [string]$SourceDir = (Join-Path (Split-Path (Resolve-Path "$PSScriptRoot\..\..")) 'skymp-src'),
  [string]$Generator = 'Visual Studio 18 2026',   # or 'Visual Studio 17 2022'
  # Short vcpkg working folders (same reason). Created if missing.
  [string]$VcpkgWorkDir = 'C:\v'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$manifest = Get-Content -Raw (Join-Path $repo 'patches\manifest.json') | ConvertFrom-Json
$pin = $manifest.upstream.pin
$patch = Join-Path $repo 'patches\skymp\light-plugins.patch'

if (-not (Test-Path (Join-Path $SourceDir '.git'))) {
  Write-Host "Cloning SkyMP into $SourceDir ..."
  git clone https://github.com/skyrim-multiplayer/skymp.git $SourceDir
  if ($LASTEXITCODE) { throw 'git clone failed' }
}
Push-Location $SourceDir
try {
  $branch = git rev-parse --abbrev-ref HEAD
  if ($branch -ne 'oathbound/light-plugins') {
    git fetch origin $pin
    git checkout -B oathbound/light-plugins $pin
    if ($LASTEXITCODE) { throw "checkout of pin $pin failed" }
    git apply --whitespace=nowarn $patch
    if ($LASTEXITCODE) { throw 'patch did not apply' }
    git add -A
    git -c user.name=oathbound -c user.email=oathbound@localhost commit -q -m 'OATHBOUND light-plugins patch'
  } else {
    Write-Host 'Branch oathbound/light-plugins already exists; building it as is.'
  }
  git submodule update --init --recursive
  if ($LASTEXITCODE) { throw 'submodule update failed' }

  $bt = Join-Path $VcpkgWorkDir 'bt'; $pk = Join-Path $VcpkgWorkDir 'pk'; $dl = Join-Path $VcpkgWorkDir 'dl'
  New-Item -ItemType Directory -Force -Path $bt, $pk, $dl | Out-Null
  $env:VCPKG_DOWNLOADS = $dl
  $fwd = { param($p) $p -replace '\\', '/' }
  cmake -S $SourceDir -B (Join-Path $SourceDir 'build') -G $Generator -A x64 `
    "-DVCPKG_ROOT=$(& $fwd (Join-Path $SourceDir 'vcpkg'))" `
    "-DVCPKG_INSTALL_OPTIONS=--x-buildtrees-root=$(& $fwd $bt);--x-packages-root=$(& $fwd $pk)" `
    "-DUNIT_DATA_DIR=$(& $fwd (Join-Path $repo 'skymp\data'))" `
    -DBUILD_SCRIPTS=OFF -DBUILD_FRONT=OFF -DBUILD_GAMEMODE=OFF -DBUILD_NODEJS=OFF `
    -DCMAKE_BUILD_TYPE=Release
  if ($LASTEXITCODE) { throw 'cmake configure failed' }
  cmake --build (Join-Path $SourceDir 'build') --config Release -- /m /v:minimal
  if ($LASTEXITCODE) { throw 'build failed' }
  Write-Host ''
  Write-Host "Built: $SourceDir\build\dist\server and $SourceDir\build\dist\client" -ForegroundColor Green
  Write-Host 'Next: scripts\skymp-build\Install-PatchedSkyMP.ps1'
} finally { Pop-Location }
