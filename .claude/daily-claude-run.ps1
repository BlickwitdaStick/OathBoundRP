# Runs a daily headless Claude Code session on the skymp-heavy-rp project.
# Called by the "Skymp-DailyClaude" Scheduled Task. It only drafts: commit/push
# are blocked by .claude/settings.json (permissions.deny), not by this
# script.

$projectDir = 'C:\Users\Vinicius\Desktop\skymp-heavy-rp'
$promptFile = Join-Path $projectDir '.claude\daily-session-prompt.md'
$logDir = Join-Path $projectDir '.claude\daily-logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$stamp = '{0:yyyy-MM-dd_HH-mm}' -f (Get-Date)
$runLog = Join-Path $logDir "run-$stamp.log"

Set-Location $projectDir
$prompt = Get-Content -LiteralPath $promptFile -Raw

& claude -p $prompt --permission-mode acceptEdits `
  --disallowedTools 'Bash(git commit*)' 'Bash(git push*)' 'Bash(git reset --hard*)' 'Bash(git clean*)' 'Bash(git branch -D*)' 'Bash(rm -rf*)' `
  --output-format text *> $runLog
