# Start-AllServices.ps1
# Orchestration script that starts every server service at once.
#
# This script used to only check that `.env` existed and launch `node` in a
# new window. If `node_modules` was missing, the service died on the first
# `require()` in a window nobody was watching -- and the orchestration
# printed "done" with the panel dead. Now each service is actually checked
# before it starts, and whatever is missing is said out loud.

$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

# Each service: folder, entry file, and whether it needs a .env to work.
$services = @(
  @{ Name = "Web Panel";       Path = "apps\web";          Entry = "server.js"; RequiresEnv = $true  },
  @{ Name = "Discord Bot";     Path = "apps\bot-discord";  Entry = "index.js";  RequiresEnv = $true  },
  @{ Name = "Game API";        Path = "apps\game-api";     Entry = "server.js"; RequiresEnv = $true  }
)

Write-Host "Starting all SkyMP Heavy RP services..." -ForegroundColor Cyan
Write-Host ""

# -- Pre-check ----------------------------------------------------------------
# Runs in full before starting anything: it is better to list everything that
# is missing at once than to discover one problem per run.
$problems = @()
$ready = @()

foreach ($svc in $services) {
  $dir = Join-Path $rootDir $svc.Path
  $envFile = Join-Path $dir ".env"
  $nodeModules = Join-Path $dir "node_modules"
  $entry = Join-Path $dir $svc.Entry

  if (-not (Test-Path -LiteralPath $entry)) {
    $problems += "$($svc.Name): entry file not found ($($svc.Path)\$($svc.Entry))."
    continue
  }

  if ($svc.RequiresEnv -and -not (Test-Path -LiteralPath $envFile)) {
    $problems += "$($svc.Name): .env is missing. Copy it from $($svc.Path)\.env.example and fill it in."
    continue
  }

  if (-not (Test-Path -LiteralPath $nodeModules)) {
    $problems += "$($svc.Name): dependencies not installed. Run: cd $($svc.Path); npm ci"
    continue
  }

  $ready += $svc
}

# The mods manifest does not block boot, but without it no player gets past the
# parity check -- so we warn loudly instead of letting it be discovered in game.
$manifestPath = Join-Path $rootDir "apps\game-api\mods.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
  Write-Warning "apps\game-api\mods.json does not exist: /mods.json will answer 503 and no player can get in."
  Write-Warning "Generate it with: cd apps\game-api; node scripts\generate-mods-manifest.js `"<server Data folder>`" --plugins-txt `"<plugins.txt>`""
  Write-Host ""
}

# A half-migrated database does not block boot: the server starts, login works,
# and only the query that touches the missing column breaks -- sometimes weeks
# later, mid-scene, with gold involved. Better to find out here.
$gamemodeDir = Join-Path $rootDir "skymp\gamemode"
if (Test-Path -LiteralPath (Join-Path $gamemodeDir "node_modules")) {
  Push-Location $gamemodeDir
  try {
    $driftOutput = & node "scripts\check-schema-drift.js" 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Database is out of sync with the migrations. The services will start, but will fail at runtime:"
      foreach ($line in $driftOutput) { Write-Host "  $line" -ForegroundColor Yellow }
      Write-Host ""
    }
  } catch {
    Write-Warning "Could not check the schema: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
}

if ($problems.Count -gt 0) {
  Write-Host "Services that will NOT start:" -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
  Write-Host ""
}

if ($ready.Count -eq 0) {
  Write-Host "No service is ready to start. Fix the items above and run again." -ForegroundColor Red
  exit 1
}

# -- Boot ---------------------------------------------------------------------
$i = 0
foreach ($svc in $ready) {
  $i++
  Write-Host "[$i/$($ready.Count + 1)] Starting $($svc.Name)..." -ForegroundColor Yellow
  Start-Process "node" -ArgumentList $svc.Entry -WorkingDirectory (Join-Path $rootDir $svc.Path) -WindowStyle Normal
}

Write-Host "[$($ready.Count + 1)/$($ready.Count + 1)] Starting SkyMP Server..." -ForegroundColor Yellow
Start-Process "powershell.exe" -ArgumentList "-ExecutionPolicy Bypass -File `"$rootDir\scripts\phase0\Start-Phase0Server.ps1`"" -WorkingDirectory "$rootDir" -WindowStyle Normal

Write-Host ""
if ($problems.Count -gt 0) {
  Write-Host "Orchestration PARTIALLY done: $($ready.Count) of $($services.Count) services started." -ForegroundColor Yellow
} else {
  Write-Host "Orchestration done: all services started." -ForegroundColor Green
}
Write-Host "To play, open the Launcher in the apps\launcher folder." -ForegroundColor Green
