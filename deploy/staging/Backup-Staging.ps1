$ErrorActionPreference = 'Stop'
$stagingDir = $PSScriptRoot
$composeFile = Join-Path $stagingDir 'compose.yaml'
$envFile = Join-Path $stagingDir '.env'
$backupDir = Join-Path $stagingDir 'backups'

if (-not (Test-Path -LiteralPath $envFile)) { throw 'deploy\staging\.env is missing.' }

$values = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $parts = $line -split '=', 2
  $values[$parts[0].Trim()] = $parts[1].Trim()
}
if (-not $values.DB_ROOT_PASS) { throw 'DB_ROOT_PASS is missing from .env.' }

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$filename = 'skymp-staging-{0}.sql.gz' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
$previousPwd = $env:MYSQL_PWD
$previousEnvFile = $env:STAGING_ENV_FILE
$env:MYSQL_PWD = $values.DB_ROOT_PASS
$env:STAGING_ENV_FILE = '.env'
try {
  # Dump to a temporary file BEFORE compressing, and exit with mariadb-dump's
  # code, not gzip's. `dump | gzip > file` would have the opposite defect:
  # `sh` (dash/ash in the official images, no pipefail) returns the exit code of
  # the LAST command in the pipe -- if mariadb-dump fails halfway (lock timeout,
  # dropped connection), gzip happily compresses what it got up to EOF and exits 0.
  # The backup would be non-empty, with a valid SHA-256, and silently truncated
  # -- only discovered on the day you really need to restore.
  & docker compose --env-file $envFile -f $composeFile exec -T -e MYSQL_PWD mariadb sh -c "mariadb-dump -uroot --single-transaction --routines --events --triggers --databases skymp_rp --add-drop-database > /tmp/skymp-backup.sql; ec=`$?; gzip -c /tmp/skymp-backup.sql > /backups/$filename; rm -f /tmp/skymp-backup.sql; exit `$ec"
  if ($LASTEXITCODE -ne 0) { throw 'mariadb-dump failed.' }
} finally {
  $env:MYSQL_PWD = $previousPwd
  $env:STAGING_ENV_FILE = $previousEnvFile
}

$backupPath = Join-Path $backupDir $filename
if (-not (Test-Path -LiteralPath $backupPath) -or (Get-Item -LiteralPath $backupPath).Length -eq 0) {
  throw 'Backup was not created or is empty.'
}
$hash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$backupPath.sha256" -Value "$hash  $filename" -Encoding ascii
Write-Host "Backup created: $backupPath" -ForegroundColor Green
Write-Host "SHA-256: $hash"
