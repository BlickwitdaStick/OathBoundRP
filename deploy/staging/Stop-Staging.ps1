param([switch]$RemoveVolumes)

$ErrorActionPreference = 'Stop'
$stagingDir = $PSScriptRoot
$composeFile = Join-Path $stagingDir 'compose.yaml'
$envFile = Join-Path $stagingDir '.env'

if (-not (Test-Path -LiteralPath $envFile)) {
  throw 'deploy\staging\.env is missing; it identifies the stack to shut down.'
}

$previousEnvFile = $env:STAGING_ENV_FILE
$env:STAGING_ENV_FILE = '.env'
try {
  $args = @('compose', '--env-file', $envFile, '-f', $composeFile, 'down')
  if ($RemoveVolumes) {
    Write-Warning 'RemoveVolumes deletes the database and crash reports of the staging stack.'
    $confirmation = Read-Host "Type REMOVE-STAGING to confirm"
    if ($confirmation -cne 'REMOVE-STAGING') { throw 'Removal cancelled.' }
    $args += '--volumes'
  }
  & docker @args
  if ($LASTEXITCODE -ne 0) { throw 'Failed to shut down the stack.' }
} finally {
  $env:STAGING_ENV_FILE = $previousEnvFile
}
