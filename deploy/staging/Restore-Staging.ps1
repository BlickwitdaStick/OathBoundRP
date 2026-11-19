param([Parameter(Mandatory = $true)][string]$BackupFile)

$ErrorActionPreference = 'Stop'
$stagingDir = $PSScriptRoot
$composeFile = Join-Path $stagingDir 'compose.yaml'
$envFile = Join-Path $stagingDir '.env'
$backupDir = Join-Path $stagingDir 'backups'

if (-not (Test-Path -LiteralPath $envFile)) { throw 'deploy\staging\.env is missing.' }
$resolvedBackupDir = (Resolve-Path -LiteralPath $backupDir).Path
$resolvedBackup = (Resolve-Path -LiteralPath $BackupFile).Path
if (-not $resolvedBackup.StartsWith($resolvedBackupDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The backup must be inside deploy\staging\backups.'
}
$filename = Split-Path -Leaf $resolvedBackup
if ($filename -notmatch '^skymp-staging-\d{8}-\d{6}\.sql\.gz$') { throw 'Invalid backup name.' }

$checksumFile = "$resolvedBackup.sha256"
if (-not (Test-Path -LiteralPath $checksumFile)) { throw 'Matching .sha256 file is missing.' }
$expected = ((Get-Content -LiteralPath $checksumFile -Raw).Trim() -split '\s+')[0]
$actual = (Get-FileHash -LiteralPath $resolvedBackup -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -cne $expected.ToLowerInvariant()) { throw 'Backup SHA-256 does not match.' }

$confirmation = Read-Host "This replaces the staging database. Type RESTORE-STAGING"
if ($confirmation -cne 'RESTORE-STAGING') { throw 'Restore cancelled.' }

$values = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $parts = $line -split '=', 2
  $values[$parts[0].Trim()] = $parts[1].Trim()
}
if (-not $values.DB_ROOT_PASS) { throw 'DB_ROOT_PASS is missing from .env.' }

$previousPwd = $env:MYSQL_PWD
$previousEnvFile = $env:STAGING_ENV_FILE
$env:MYSQL_PWD = $values.DB_ROOT_PASS
$env:STAGING_ENV_FILE = '.env'
try {
  & docker compose --env-file $envFile -f $composeFile stop web game-api bot-discord
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop the database consumers.' }

  # `gzip -dc ... | mariadb -uroot` would have the same defect as the backup: `sh`
  # (dash/ash, no pipefail) returns mariadb's exit code, not gzip's. If
  # the /backups volume is mounted wrong (the file does not exist in the
  # container even though it exists on the host), gzip fails and writes nothing, but
  # mariadb reads an empty stdin, runs no statement and exits 0 -- a
  # "successful" restore that restored nothing. Decompress to a file first
  # and use `&&`, which propagates the first real error correctly.
  & docker compose --env-file $envFile -f $composeFile exec -T -e MYSQL_PWD mariadb sh -c "gzip -dc /backups/$filename > /tmp/skymp-restore.sql && mariadb -uroot < /tmp/skymp-restore.sql; ec=`$?; rm -f /tmp/skymp-restore.sql; exit `$ec"
  if ($LASTEXITCODE -ne 0) { throw 'Restore failed; keep the services stopped and investigate the dump.' }

  & docker compose --env-file $envFile -f $composeFile --profile bootstrap run --rm --entrypoint sh migrate -c "npm ci --omit=dev && npm run check:schema:env -- --strict"
  if ($LASTEXITCODE -ne 0) { throw 'Restore finished, but the restored schema differs from the migrations.' }

  & docker compose --env-file $envFile -f $composeFile up -d web game-api bot-discord
  if ($LASTEXITCODE -ne 0) { throw 'Database restored, but the services did not restart.' }
} finally {
  $env:MYSQL_PWD = $previousPwd
  $env:STAGING_ENV_FILE = $previousEnvFile
}

Write-Host 'Restore complete and schema validated.' -ForegroundColor Green
