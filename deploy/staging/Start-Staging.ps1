param(
  [switch]$BootstrapDatabase,
  [switch]$StartSkyMP
)

$ErrorActionPreference = 'Stop'
$stagingDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $stagingDir '..\..')).Path
$composeFile = Join-Path $stagingDir 'compose.yaml'
$envFile = Join-Path $stagingDir '.env'

if (-not (Test-Path -LiteralPath $envFile)) {
  throw "deploy\staging\.env is missing. Copy .env.example, replace every placeholder and run again."
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker CLI not found.'
}

& docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Engine is not running. Start Docker Desktop and run again.'
}

$previousEnvFile = $env:STAGING_ENV_FILE
$env:STAGING_ENV_FILE = '.env'
try {
  & docker compose --env-file $envFile -f $composeFile config --quiet
  if ($LASTEXITCODE -ne 0) { throw 'compose.yaml or .env is invalid.' }

  & docker compose --env-file $envFile -f $composeFile up -d mariadb
  if ($LASTEXITCODE -ne 0) { throw 'Staging MariaDB did not start.' }

  if ($BootstrapDatabase) {
    & docker compose --env-file $envFile -f $composeFile --profile bootstrap run --rm migrate
    if ($LASTEXITCODE -ne 0) {
      throw 'Bootstrap refused or failed. It only runs on an empty database; do not delete the volume to hide the error.'
    }
  }

  & docker compose --env-file $envFile -f $composeFile up -d web game-api bot-discord
  if ($LASTEXITCODE -ne 0) { throw 'One or more Node services did not start.' }

  & docker compose --env-file $envFile -f $composeFile ps

  if ($StartSkyMP) {
    $serverScript = Join-Path $repoRoot 'scripts\phase0\Start-Phase0Server.ps1'
    Start-Process 'powershell.exe' -ArgumentList "-ExecutionPolicy Bypass -File `"$serverScript`"" -WorkingDirectory $repoRoot -WindowStyle Normal
    Write-Host 'SkyMP started on the host. Confirm the containers are healthy before opening the launcher.' -ForegroundColor Yellow
  }
} finally {
  $env:STAGING_ENV_FILE = $previousEnvFile
}
