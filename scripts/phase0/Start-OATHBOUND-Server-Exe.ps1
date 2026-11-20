$ErrorActionPreference = 'Stop'
Set-Location 'E:\SkyrimRP\skymp-heavy-rp'

$startupScript = 'E:\SkyrimRP\skymp-heavy-rp\scripts\phase0\Start-AllServices.ps1'
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

& $powerShell -NoProfile -ExecutionPolicy Bypass -File $startupScript

if ($LASTEXITCODE -ne 0) {
    Write-Host "Server startup failed. Exit code: $LASTEXITCODE" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit $LASTEXITCODE
}
