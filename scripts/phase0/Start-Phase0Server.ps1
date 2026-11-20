param(
  [int]$Seconds = 0,
  [switch]$EnableFaunaCensus,
  [switch]$EnableCorpseProbe
)

$ErrorActionPreference = "Stop"

# Clicking inside this window starts QuickEdit "Select" mode, which pauses any
# program writing to it: the game server froze mid-boot and nobody could
# connect until someone pressed Esc. Turn QuickEdit off for this window only.
try {
  Add-Type -Namespace OathboundConsole -Name Mode -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int h);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@
  $stdin = [OathboundConsole.Mode]::GetStdHandle(-10)
  $mode = 0
  if ([OathboundConsole.Mode]::GetConsoleMode($stdin, [ref]$mode)) {
    # clear ENABLE_QUICK_EDIT_MODE (0x40), keep ENABLE_EXTENDED_FLAGS (0x80) set so it sticks
    [void][OathboundConsole.Mode]::SetConsoleMode($stdin, (($mode -band (-bnot 0x40)) -bor 0x80))
  }
} catch {
  Write-Warning "Could not turn off QuickEdit: clicking in this window may pause the server (press Esc to resume)."
}

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$server = Join-Path $rootDir "skymp\server"
$entry = Join-Path $server "dist_back\skymp5-server.js"

if (-not (Test-Path -LiteralPath $entry)) {
  Write-Error "Server entry not found. Run scripts/phase0/Install-SkyMPServerArtifact.ps1 first."
}

$buildInfoPath = Join-Path $server "BUILD_INFO.json"
if (-not (Test-Path -LiteralPath $buildInfoPath)) {
  & (Join-Path $PSScriptRoot "Write-ServerBuildInfo.ps1") -ServerPath $server
}
$buildInfo = Get-Content -Raw -LiteralPath $buildInfoPath | ConvertFrom-Json
Write-Host "SkyMP artifact: pin=$($buildInfo.declaredUpstreamPin) commitVerified=$($buildInfo.commitVerified) package=$($buildInfo.packageVersion)"
if (-not $buildInfo.commitVerified) {
  Write-Warning "Commit do binario nao comprovado; identidade preservada pelos hashes em BUILD_INFO.json."
}

Push-Location $server
try {
  if ($EnableFaunaCensus) {
    $env:ENABLE_FAUNA_CENSUS = "true"
  }
  if ($EnableCorpseProbe) {
    $env:ENABLE_CORPSE_PROBE = "true"
    Write-Warning "Corpse probe writes and restores an NPC corpse inventory. Use only in a supervised lab session."
  }

  if ($Seconds -gt 0) {
    $out = Join-Path $server "phase0-server.out.log"
    $err = Join-Path $server "phase0-server.err.log"
    Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue

    $process = Start-Process -FilePath "node" -ArgumentList "dist_back/skymp5-server.js" -WorkingDirectory $server -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds $Seconds

    $alive = -not $process.HasExited
    $tcpPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $process.Id } | Select-Object LocalAddress, LocalPort, State
    $udpPorts = Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $process.Id } | Select-Object LocalAddress, LocalPort

    if ($alive) {
      Stop-Process -Id $process.Id -Force
    }

    Write-Host "PID=$($process.Id) AliveAfter${Seconds}s=$alive ExitCode=$($process.ExitCode)"
    Write-Host "--- TCP LISTEN PORTS ---"
    $tcpPorts | Format-Table -AutoSize
    Write-Host "--- UDP PORTS ---"
    $udpPorts | Format-Table -AutoSize
    Write-Host "--- STDOUT ---"
    Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Select-Object -Last 160
    Write-Host "--- STDERR ---"
    Get-Content -LiteralPath $err -ErrorAction SilentlyContinue
  } else {
    # Everything the server prints also goes to skymp/server/logs/, so a
    # problem can be diagnosed after the fact (the window alone loses it).
    $logDir = Join-Path $server "logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $logFile = Join-Path $logDir ("server-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Get-ChildItem -LiteralPath $logDir -Filter 'server-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 | Remove-Item -ErrorAction SilentlyContinue
    Write-Host "Logging to $logFile"
    # cmd merges stderr into stdout before PowerShell sees it (PowerShell 5
    # would turn each stderr line into an error record).
    cmd /c "node dist_back/skymp5-server.js 2>&1" | Tee-Object -FilePath $logFile
    # Start-AllServices opens this script in its own window, which used to
    # close the instant the server died — taking the error message with it.
    # Keep it open so the reason can be read.
    Write-Host ""
    Write-Host "SkyMP server stopped (exit code $LASTEXITCODE). If this was unexpected, the error is above." -ForegroundColor Red
    Read-Host "Press Enter to close this window"
  }
} finally {
  Pop-Location
}
